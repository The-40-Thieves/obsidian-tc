// `vault` may be omitted when exactly one vault is VISIBLE to the caller (token binding + the
// vault's own folder ACL). Resolved once in dispatch, so every facade mode (flat, triad, domain)
// and every tool gets it. Security-relevant: it decides which vault a call acts on, so the cases
// below pin the refusals as hard as the happy path.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildFullRegistry } from "../scripts/docgen/build-registry";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { toInputJson } from "../src/mcp/facade";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { isOmittableVaultArg } from "../src/mcp/registry/vault-default";
import { createMcpServer } from "../src/mcp/server";
import { registerM1Tools } from "../src/tools/m1";
import { VaultRegistry } from "../src/vault/registry";
import { makeVisibleVaultIds } from "../src/vault/visible-vaults";
import { openMemoryDb } from "./helpers";
import { topLevelShape } from "./schema-introspect";
import { makeTempDir, rmTemp } from "./tmp";

const HIDDEN = new FolderAcl({
  readOnly: false,
  defaultScopes: [],
  rules: [],
  readPaths: [],
});

interface Harness {
  registry: ToolRegistry;
  vaultRegistry: VaultRegistry;
  ctx: (over?: Partial<CallerContext>) => CallerContext;
  roots: Record<string, string>;
  cleanup(): void;
}

/** One real registry wired exactly like production (`makeVisibleVaultIds` + `aclResolver`), over
 *  the given vault ids, each holding `hello.md` whose body names its own vault. `hidden` ids get a
 *  folder ACL with an empty read whitelist — the caller can read nothing there. */
function harness(ids: string[], hidden: string[] = []): Harness {
  const roots: Record<string, string> = {};
  for (const id of ids) {
    roots[id] = makeTempDir(`obtc-dv-${id}-`);
    writeFileSync(join(roots[id] as string, "hello.md"), `body of ${id}\n`);
  }
  const vaultRegistry = new VaultRegistry(ids.map((id) => ({ id, path: roots[id] as string })));
  const aclFor = (id: string): FolderAcl | undefined => (hidden.includes(id) ? HIDDEN : undefined);
  const registry = new ToolRegistry({
    aclResolver: aclFor,
    visibleVaultIds: makeVisibleVaultIds(vaultRegistry, aclFor),
  });
  registerM1Tools(registry, {
    vaultRegistry,
    version: "test",
    startedAt: 0,
    embeddings: { provider: "ollama", model: "nomic-embed-text" },
  });
  const db = openMemoryDb();
  provisionCacheDb(db);
  return {
    registry,
    vaultRegistry,
    roots,
    ctx: (over = {}) => ({
      caller: "t",
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: ids[0] as string,
      db,
      ...over,
    }),
    cleanup: () => {
      for (const r of Object.values(roots)) rmTemp(r);
    },
  };
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});
function mk(ids: string[], hidden: string[] = []): Harness {
  const h = harness(ids, hidden);
  cleanups.push(h.cleanup);
  return h;
}

async function readHello(h: Harness, ctx: CallerContext, args: Record<string, unknown> = {}) {
  return h.registry.dispatch("read_note", { path: "hello.md", ...args }, ctx);
}

describe("omitted vault, one visible vault", () => {
  it("resolves to the only configured vault (stdio, unbound)", async () => {
    const h = mk(["solo"]);
    const res = await readHello(h, h.ctx());
    expect(res.ok).toBe(true);
    if (res.ok) expect(JSON.stringify(res.data)).toContain("body of solo");
  });

  it("resolves to the only vault the ACL leaves visible, not a hidden one", async () => {
    const h = mk(["open", "secret"], ["secret"]);
    const res = await readHello(h, h.ctx({ vaultId: "secret" }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(JSON.stringify(res.data)).toContain("body of open");
  });

  it("a token bound to one of several vaults defaults to its bound vault", async () => {
    const h = mk(["a", "b", "c"]);
    const res = await readHello(h, h.ctx({ vaultId: "b", vaultBound: true }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(JSON.stringify(res.data)).toContain("body of b");
  });
});

describe("omitted vault, more than one visible vault", () => {
  it("is a validation_error listing exactly the visible ids, never an ACL-hidden one", async () => {
    const h = mk(["a", "b", "secret"], ["secret"]);
    const res = await readHello(h, h.ctx());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("validation_error");
    const details = res.error.details as { visible_vaults?: string[] };
    expect(details.visible_vaults).toEqual(["a", "b"]);
    expect(JSON.stringify(res.error)).not.toContain("secret");
  });

  it("does not guess the registry default", async () => {
    const h = mk(["a", "b"]);
    const res = await readHello(h, h.ctx({ vaultId: "a" }));
    expect(res.ok).toBe(false);
  });

  it("a caller without read:vault learns no ids (same gate as list_vaults)", async () => {
    const h = mk(["a", "b"]);
    const res = await readHello(h, h.ctx({ grantedScopes: new Set(["read:note"]) }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("validation_error");
    expect(JSON.stringify(res.error)).not.toMatch(/"a"|"b"/);
  });
});

describe("zero visible vaults, bound token", () => {
  it("a bound vault the ACL hides is not defaulted to", async () => {
    const h = mk(["a", "secret"], ["secret"]);
    const res = await readHello(h, h.ctx({ vaultId: "secret", vaultBound: true }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("validation_error");
    expect((res.error.details as { visible_vaults?: string[] }).visible_vaults).toEqual([]);
  });
});

describe("an explicit vault is unchanged", () => {
  it("a bound token naming another vault is still forbidden", async () => {
    const h = mk(["a", "b"]);
    const res = await readHello(h, h.ctx({ vaultId: "a", vaultBound: true }), { vault: "b" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("forbidden");
  });

  it("stdio naming a vault reads that vault even with several configured", async () => {
    const h = mk(["a", "b"]);
    const res = await readHello(h, h.ctx({ vaultId: "a" }), { vault: "b" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(JSON.stringify(res.data)).toContain("body of b");
  });

  it("a wrong explicit id on a single-vault server is still vault_not_found, not defaulted", async () => {
    const h = mk(["solo"]);
    const res = await readHello(h, h.ctx(), { vault: "nope" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("vault_not_found");
  });

  it("an explicit invalid value is still rejected by the schema", async () => {
    const h = mk(["solo"]);
    const res = await readHello(h, h.ctx(), { vault: "Not A Slug" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("validation_error");
  });
});

describe("only the shared VaultId field is defaulted", () => {
  const defs = (): ToolRegistry => {
    const reg = new ToolRegistry({ visibleVaultIds: () => ["only"] });
    reg.register({
      name: "optional_vault_echo",
      description: "vault is already optional",
      inputSchema: z.object({ vault: VaultId.optional() }).strict(),
      requiredScopes: [],
      handler: (i: { vault?: string }) => ({ vault: i.vault ?? null }),
    });
    reg.register({
      name: "no_vault_echo",
      description: "takes no vault at all",
      inputSchema: z.object({}).strict(),
      requiredScopes: [],
      handler: (i: unknown) => ({ got: i }),
    });
    reg.register({
      name: "plain_string_vault_echo",
      description: "a `vault` that is not a vault id",
      inputSchema: z.object({ vault: z.string() }).strict(),
      requiredScopes: [],
      handler: (i: { vault: string }) => ({ vault: i.vault }),
    });
    return reg;
  };
  const ctx = (): CallerContext => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    return { caller: "t", authenticated: true, grantedScopes: new Set(["*"]), vaultId: "only", db };
  };

  it("leaves an already-optional vault alone (not forced to the visible vault)", async () => {
    const res = await defs().dispatch("optional_vault_echo", {}, ctx());
    expect(res).toMatchObject({ ok: true, data: { vault: null } });
  });

  it("does not inject into a tool with no vault field (strict schema)", async () => {
    const res = await defs().dispatch("no_vault_echo", {}, ctx());
    expect(res).toMatchObject({ ok: true, data: { got: {} } });
  });

  it("does not default a `vault` field that is not the shared VaultId", async () => {
    const res = await defs().dispatch("plain_string_vault_echo", {}, ctx());
    expect(res.ok).toBe(false);
  });
});

describe("advertised input schema", () => {
  it("no longer requires vault, and says when it may be omitted", () => {
    const h = mk(["solo"]);
    const def = h.registry.list().find((d) => d.name === "read_note");
    expect(def).toBeDefined();
    const json = toInputJson(def?.inputSchema as z.ZodType) as {
      required?: string[];
      properties: Record<string, { description?: string }>;
    };
    expect(json.required ?? []).not.toContain("vault");
    expect(json.required).toContain("path");
    expect(json.properties.vault).toBeDefined();
    expect(json.properties.vault?.description).toMatch(/omit.*only one vault/i);
  });

  it("leaves a schema with no vault field byte-identical", () => {
    const schema = z.object({ q: z.string() }).strict();
    const json = toInputJson(schema) as { required?: string[] };
    expect(json.required).toEqual(["q"]);
  });
});

describe("every facade mode routes through the same default", () => {
  async function connect(mode: "flat" | "triad" | "domain") {
    const h = mk(["solo"]);
    const server = createMcpServer({
      name: "x",
      version: "0",
      registry: h.registry,
      context: () => h.ctx(),
      visibility: { grantedScopes: new Set(["*"]) },
      facadeMode: mode,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(ct);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    return client;
  }
  const text = (res: unknown): string => (res as { content: [{ text: string }] }).content[0].text;

  it("flat: read_note without vault", async () => {
    const c = await connect("flat");
    const res = await c.callTool({ name: "read_note", arguments: { path: "hello.md" } });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain("body of solo");
  });

  it("triad: call_capability read_note without vault", async () => {
    const c = await connect("triad");
    const res = await c.callTool({
      name: "call_capability",
      arguments: { name: "read_note", args: { path: "hello.md" } },
    });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain("body of solo");
  });

  it("domain: the notes domain tool with action read_note without vault", async () => {
    const c = await connect("domain");
    const res = await c.callTool({
      name: "notes",
      arguments: { action: "read_note", args: { path: "hello.md" } },
    });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain("body of solo");
  });
});

describe("surface sweep", () => {
  // The shared-layer claim: no tool is left out. Any tool whose top-level input still has a REQUIRED
  // `vault` field must be one dispatch can default (the shared VaultId), so a future tool that
  // declares its own `z.string()` vault (or wraps VaultId and breaks the identity test) fails here
  // instead of silently keeping the first-call validation_error.
  it("every tool with a required top-level vault field is omittable", () => {
    const defs = buildFullRegistry().list();
    expect(defs.length).toBeGreaterThan(100);
    const required = defs.filter((d) => {
      const field = topLevelShape(d.inputSchema)?.vault;
      return field !== undefined && !["optional", "default"].includes(field.def.type);
    });
    expect(required.length).toBeGreaterThan(100);
    const stuck = required
      .filter((d) => !isOmittableVaultArg(d.inputSchema, d.vaultArg ?? "vault"))
      .map((d) => d.name);
    expect(stuck).toEqual([]);
  });

  it("advertises none of them as requiring vault", () => {
    const stillRequired = buildFullRegistry()
      .list()
      .filter((d) => isOmittableVaultArg(d.inputSchema, "vault"))
      .filter((d) =>
        (toInputJson(d.inputSchema) as { required?: string[] }).required?.includes("vault"),
      )
      .map((d) => d.name);
    expect(stillRequired).toEqual([]);
  });
});
