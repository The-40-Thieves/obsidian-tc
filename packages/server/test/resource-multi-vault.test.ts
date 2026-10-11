// Note resources serve every registered vault the caller may read. A trusted, unbound caller (stdio)
// names any vault in obsidian-tc://<vault>/<path>, and resources/list enumerates them all, each
// filtered by that vault's own ACL. A vault-bound caller (an HTTP token, vaultBound: true) and
// resources.boundVaultOnly keep the old refusal. A refusal in another vault answers exactly as a
// missing note does, so the URI cannot be used as a vault- or note-existence oracle.
import { linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AclConfigT } from "../src/acl";
import { internalReasonOf } from "../src/mcp/resource-errors";
import {
  buildResourceUri,
  listResources,
  listResourcesFor,
  readResourceFor,
} from "../src/mcp/resources";
import { createMcpServer } from "../src/mcp/server";
import { makeTestVault, type TestVault } from "./m1-helpers";
import { makeTempDir, rmTemp } from "./tmp";

// The native no-follow open refuses a path AFTER the ACL and stat checks have passed
// (notes-io's mapNativeReadError). The refusal is forced on the read alone, so locate still passes.
const nativeRefusal = vi.hoisted(() => ({ on: false }));
vi.mock("../src/vault/notes-io", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vault/notes-io")>();
  return {
    ...actual,
    readNote: (abs: string) => {
      if (nativeRefusal.on)
        throw err.aclDenied("safe open refused the path: forced by test", { path: abs });
      return actual.readNote(abs);
    },
  };
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
});

interface TwoVaults {
  /** Vault `test`: the caller's own vault, the trusted default. */
  v: TestVault;
  /** Vault `other`: registered at runtime, the second vault under test. */
  root2: string;
}

function twoVaults(
  opts: {
    files?: Record<string, string>;
    acl?: Partial<AclConfigT>;
    setup?: (root: string) => void;
    boundVaultOnly?: boolean;
  } = {},
): TwoVaults {
  const v = makeTestVault({
    files: { "a.md": "A" },
    centralAcl: true,
    aclByVault: opts.acl ? { other: opts.acl } : undefined,
    boundVaultOnly: opts.boundVaultOnly,
  });
  cleanups.push(() => v.cleanup());
  const root2 = makeTempDir("obtc-vault2-");
  cleanups.push(() => rmTemp(root2));
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    mkdirSync(dirname(join(root2, rel)), { recursive: true });
    writeFileSync(join(root2, rel), content);
  }
  opts.setup?.(root2);
  v.vaultRegistry.register({ id: "other", path: root2 });
  return { v, root2 };
}

const uri = (vault: string, rel: string) => buildResourceUri(vault, rel);

/** The code and message of the refusal a read throws. Fails the test if the read succeeds. */
function refused(run: () => unknown): { code: string; message: string } {
  try {
    run();
  } catch (e) {
    const { code, message } = e as { code?: string; message: string };
    return { code: code ?? "", message };
  }
  throw new Error("expected the resource read to be refused");
}

/** resources/read for `uri` as `ctx`, through the same entry point the MCP server uses. */
function readAs(v: TestVault, ctx: ReturnType<TestVault["ctx"]>, target: string) {
  return () => readResourceFor({ registry: v.registry }, v.vaultRegistry, ctx, target);
}

function textOf(result: { contents: unknown[] }): string {
  return (result.contents[0] as { text: string }).text;
}

describe("note resources serve every registered vault the caller may read", () => {
  it("an unbound caller reads a second registered vault's note, over resources/read and read_resources", async () => {
    const { v } = twoVaults({ files: { "pub/x.md": "X body" } });
    expect(textOf(readAs(v, v.ctx(), uri("other", "pub/x.md"))())).toBe("X body");
    const d = await v.registry.dispatch(
      "read_resources",
      { uris: [uri("other", "pub/x.md")] },
      v.ctx(),
    );
    if (!d.ok) throw new Error(`read_resources failed: ${d.error.code}`);
    const item = (d.data as { results: { ok: boolean; text?: string }[] }).results[0];
    expect(item).toMatchObject({ ok: true, text: "X body" });
  });

  it("a denied folder in vault 2 is refused with the same error as a note that does not exist", () => {
    const { v } = twoVaults({
      files: { "pub/a.md": "A", "secret/b.md": "S" },
      acl: { readPaths: ["pub/**"] },
    });
    // Existence floor: the allowed note in vault 2 really is readable, so "everything refused"
    // cannot pass this test vacuously.
    expect(textOf(readAs(v, v.ctx(), uri("other", "pub/a.md"))())).toBe("A");
    const denied = refused(readAs(v, v.ctx(), uri("other", "secret/b.md")));
    const missing = refused(readAs(v, v.ctx(), uri("other", "secret/nope.md")));
    expect(denied).toEqual(missing);
    expect(denied.code).toBe("note_not_found");
  });

  it("an unknown vault and a vault the caller may not read give identical errors", () => {
    const { v } = twoVaults({ files: { "a.md": "A" }, acl: { readPaths: [] } });
    expect(textOf(readAs(v, v.ctx(), uri("test", "a.md"))())).toBe("A");
    const unknown = refused(readAs(v, v.ctx(), uri("no-such-vault", "a.md")));
    const forbidden = refused(readAs(v, v.ctx(), uri("other", "a.md")));
    expect(forbidden).toEqual(unknown);
  });

  it("a hard-linked note in vault 2 is refused with the same error as a missing note", () => {
    const { v } = twoVaults({
      files: { "real.md": "R", "plain.md": "P" },
      setup: (root) => linkSync(join(root, "real.md"), join(root, "alias.md")),
    });
    // Existence floor: an unlinked note in vault 2 is readable, so the refusals below are the link's.
    expect(textOf(readAs(v, v.ctx(), uri("other", "plain.md"))())).toBe("P");
    const alias = refused(readAs(v, v.ctx(), uri("other", "alias.md")));
    const missing = refused(readAs(v, v.ctx(), uri("other", "nope.md")));
    expect(alias).toEqual(missing);
  });

  it("a symlink in vault 2 that escapes the vault, or leads into a denied folder, is refused as a missing note", () => {
    const outside = makeTempDir("obtc-outside-");
    cleanups.push(() => rmTemp(outside));
    const { v } = twoVaults({
      files: { "secret/b.md": "S", "pub/a.md": "A" },
      acl: { readPaths: ["pub/**"] },
      setup: (root) => {
        writeFileSync(join(outside, "x.md"), "OUTSIDE");
        symlinkSync(join(outside, "x.md"), join(root, "pub", "escape.md"));
        symlinkSync(join(root, "secret", "b.md"), join(root, "pub", "peek.md"));
      },
    });
    expect(textOf(readAs(v, v.ctx(), uri("other", "pub/a.md"))())).toBe("A");
    const missing = refused(readAs(v, v.ctx(), uri("other", "pub/nope.md")));
    expect(refused(readAs(v, v.ctx(), uri("other", "pub/escape.md")))).toEqual(missing);
    expect(refused(readAs(v, v.ctx(), uri("other", "pub/peek.md")))).toEqual(missing);
  });

  it("boundVaultOnly: true restores the old refusal for a foreign vault, known or not, in resources and read_resources", async () => {
    const { v } = twoVaults({ files: { "a.md": "A" }, boundVaultOnly: true });
    expect(refused(readAs(v, v.ctx(), uri("other", "a.md"))).code).toBe("forbidden");
    expect(refused(readAs(v, v.ctx(), uri("no-such-vault", "a.md"))).code).toBe("forbidden");
    // The caller's own vault is untouched by the opt-out.
    expect(textOf(readAs(v, v.ctx(), uri("test", "a.md"))())).toBe("A");
    const d = await v.registry.dispatch(
      "read_resources",
      { uris: [uri("other", "a.md")] },
      v.ctx(),
    );
    if (!d.ok) throw new Error(`read_resources failed: ${d.error.code}`);
    const item = (d.data as { results: { ok: boolean; error?: { code: string } }[] }).results[0];
    expect(item).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("a caller bound to one vault cannot read another vault through a resource", () => {
    const { v } = twoVaults({ files: { "a.md": "A" } });
    const bound = v.ctx({ vaultBound: true });
    expect(refused(readAs(v, bound, uri("other", "a.md"))).code).toBe("forbidden");
    expect(textOf(readAs(v, bound, uri("test", "a.md"))())).toBe("A");
  });

  it("resources/list enumerates only the notes the caller may read, across vaults, without a page gap", () => {
    const { v } = twoVaults({
      files: { "pub/a.md": "A", "pub/c.md": "C", "secret/b.md": "S" },
      acl: { readPaths: ["pub/**"] },
    });
    const ctx = v.ctx();
    const aclFor = (id: string) => v.registry.aclFor(id);
    const readable = [uri("other", "pub/a.md"), uri("other", "pub/c.md"), uri("test", "a.md")];
    expect(
      listResourcesFor(v.registry, v.vaultRegistry, ctx)
        .resources.map((r) => r.uri)
        .sort(),
    ).toEqual(readable.sort());
    // A page of one is cut AFTER the ACL filter: walking every page yields exactly the readable set.
    const walked: string[] = [];
    let cursor: string | undefined;
    do {
      const page = listResources(v.vaultRegistry, ctx, aclFor, cursor, 1);
      walked.push(...page.resources.map((r) => r.uri));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(walked.sort()).toEqual(readable.sort());
    // A vault-bound caller lists its own vault only, as before.
    const bound = listResourcesFor(v.registry, v.vaultRegistry, v.ctx({ vaultBound: true }));
    expect(bound.resources.map((r) => r.uri)).toEqual([uri("test", "a.md")]);
  });

  it("a read refused after the locate checks answers as a missing note, audited as acl_denied", () => {
    const { v } = twoVaults({ files: { "pub/a.md": "A" }, acl: { readPaths: ["pub/**"] } });
    // Existence floor: the note really is readable, so the refusal below is the read's alone.
    expect(textOf(readAs(v, v.ctx(), uri("other", "pub/a.md"))())).toBe("A");
    const missing = refused(readAs(v, v.ctx(), uri("other", "pub/nope.md")));
    nativeRefusal.on = true;
    try {
      const refusedRead = refused(readAs(v, v.ctx(), uri("other", "pub/a.md")));
      expect(refusedRead).toEqual(missing);
      let thrown: unknown;
      try {
        readAs(v, v.ctx(), uri("other", "pub/a.md"))();
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toMatchObject({ code: "note_not_found" });
      expect(internalReasonOf(thrown)).toBe("acl_denied");
    } finally {
      nativeRefusal.on = false;
    }
  });

  it("resources/list leaves out hard-linked notes in every vault, before paging", () => {
    const { v } = twoVaults({
      files: { "pub/a.md": "A", "pub/c.md": "C", "pub/real.md": "R" },
      acl: { readPaths: ["pub/**"] },
      setup: (root) => linkSync(join(root, "pub", "real.md"), join(root, "pub", "alias.md")),
    });
    writeFileSync(join(v.root, "own.md"), "O");
    writeFileSync(join(v.root, "own-real.md"), "R");
    linkSync(join(v.root, "own-real.md"), join(v.root, "own-alias.md"));
    const ctx = v.ctx();
    const aclFor = (id: string) => v.registry.aclFor(id);
    // Existence floor: the unlinked notes are listed, so an empty listing cannot pass. Hard-linked
    // ones (pub/real.md, pub/alias.md, own-real.md, own-alias.md) must not appear.
    const readable = [
      uri("other", "pub/a.md"),
      uri("other", "pub/c.md"),
      uri("test", "a.md"),
      uri("test", "own.md"),
    ].sort();
    expect(
      listResourcesFor(v.registry, v.vaultRegistry, ctx)
        .resources.map((r) => r.uri)
        .sort(),
    ).toEqual(readable);
    // One page per readable note: a hard link does not take a page slot or a cursor step.
    const walked: string[] = [];
    let pages = 0;
    let cursor: string | undefined;
    do {
      const page = listResources(v.vaultRegistry, ctx, aclFor, cursor, 1);
      pages += 1;
      walked.push(...page.resources.map((r) => r.uri));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(walked.sort()).toEqual(readable);
    expect(pages).toBe(readable.length);
  });

  it("resources.boundVaultOnly reaches resources/read over MCP through the registry", async () => {
    const connect = async (boundVaultOnly: boolean) => {
      const { v } = twoVaults({ files: { "a.md": "A" }, boundVaultOnly });
      const server = createMcpServer({
        name: "x",
        version: "0",
        registry: v.registry,
        context: () => v.ctx(),
        visibility: { grantedScopes: new Set(["*"]) },
        vaultRegistry: v.vaultRegistry,
        facadeMode: "triad",
      });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await server.connect(st);
      const client = new Client({ name: "t", version: "0" });
      await client.connect(ct);
      return {
        client,
        close: async () => {
          await client.close();
          await server.close();
        },
      };
    };
    const open = await connect(false);
    try {
      const r = await open.client.readResource({ uri: uri("other", "a.md") });
      expect((r.contents[0] as { text: string }).text).toBe("A");
    } finally {
      await open.close();
    }
    const closed = await connect(true);
    try {
      await expect(closed.client.readResource({ uri: uri("other", "a.md") })).rejects.toThrow();
    } finally {
      await closed.close();
    }
  });
});
