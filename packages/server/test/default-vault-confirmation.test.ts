// Security round on the omitted-`vault` default. On stdio `ctx.vaultId` is the FIRST configured vault
// and the caller is unbound; when that vault's folder ACL hides it and exactly one other vault is
// visible, an omitted `vault` is filled with the OTHER one. Everything keyed on a per-call vault must
// follow the vault the call acts on (the EFFECT vault), not `ctx.vaultId`: the confirmation the
// operator is shown and mints, the args hash it is bound to, the audit row, the idempotency claim
// and the task job. The same divergence existed before the default for an EXPLICIT `vault` that is
// not `ctx.vaultId` (the cases below run both spellings).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ServerConfigSchema, VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import { CapabilityCache, createBridgeClient, fakeBridgeTransport } from "../src/bridge";
import { planElicitMint } from "../src/cli/commands/elicit-mint";
import { provisionCacheDb } from "../src/db/provision";
import { elicitVerifier, issueElicitToken } from "../src/elicit";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";
import { JobQueue } from "../src/scheduler/job-queue";
import { registerM1Tools } from "../src/tools/m1";
import { defineTool } from "../src/tools/m1/define";
import { registerM4Tools } from "../src/tools/m4";
import { VaultRegistry } from "../src/vault/registry";
import { makeVisibleVaultIds } from "../src/vault/visible-vaults";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const HIDDEN = new FolderAcl({ readOnly: false, defaultScopes: [], rules: [], readPaths: [] });
const OPEN = new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] });
const FIRST = "first"; // ctx.vaultId on stdio; its ACL hides it
const OTHER = "other"; // the one visible vault
const CALLER = "stdio";

function boot() {
  const roots: Record<string, string> = {
    [FIRST]: makeTempDir("obtc-dvc-first-"),
    [OTHER]: makeTempDir("obtc-dvc-other-"),
  };
  const write = (vault: string, rel: string, content: string) => {
    mkdirSync(dirname(join(roots[vault] as string, rel)), { recursive: true });
    writeFileSync(join(roots[vault] as string, rel), content);
  };
  const db = openMemoryDb();
  provisionCacheDb(db);
  const vaultRegistry = new VaultRegistry(
    [FIRST, OTHER].map((id) => ({ id, name: id, path: roots[id] as string })),
  );
  const aclFor = (id: string): FolderAcl | undefined => (id === FIRST ? HIDDEN : undefined);
  const bridgeVaults: string[] = [];
  const capabilities = new CapabilityCache();
  for (const id of [FIRST, OTHER])
    capabilities.set(id, {
      companion: "reachable",
      plugins: { quickadd: { installed: true }, git: { installed: true } },
    });
  const client = createBridgeClient({
    baseUrl: "http://127.0.0.1:27124",
    apiKey: "k",
    fetchFn: fakeBridgeTransport({
      routes: {
        "POST /obsidian-tc/v1/git/commit": { body: { ok: true, result: { sha: "abc" } } },
        "POST /obsidian-tc/v1/quickadd/trigger": { body: { ok: true, result: { ok: true } } },
        "POST /obsidian-tc/v1/commands/execute": {
          body: { ok: true, result: { fired_at: "t", plugin_response: { ok: true } } },
        },
      },
    }),
  });
  const registry = new ToolRegistry({
    verifyElicit: elicitVerifier,
    aclResolver: aclFor,
    visibleVaultIds: makeVisibleVaultIds(vaultRegistry, aclFor),
    rootResolver: (id) => roots[id],
  });
  registerM1Tools(registry, {
    vaultRegistry,
    version: "test",
    startedAt: 0,
    embeddings: { provider: "ollama", model: "nomic-embed-text" },
  });
  registry.register(
    defineTool({
      name: "task_probe",
      domain: "vault",
      vaultArg: "vault",
      description: "test probe",
      inputSchema: z.object({ vault: VaultId }).strict(),
      outputSchema: z.object({ ok: z.boolean() }),
      requiredScopes: ["read:vault"],
      taskAugmentable: true,
      handler: () => ({ ok: true }),
    }),
  );
  // A keyed, non-HITL tool: the smallest thing that claims an idempotency slot.
  registry.register(
    defineTool({
      name: "idem_probe",
      domain: "vault",
      vaultArg: "vault",
      description: "test probe",
      inputSchema: z
        .object({ vault: VaultId, idempotency_key: z.string().min(1).optional() })
        .strict(),
      outputSchema: z.object({ ok: z.boolean() }),
      requiredScopes: ["read:vault"],
      handler: () => ({ ok: true }),
    }),
  );
  registerM4Tools(registry, {
    vaultRegistry,
    capabilities,
    // Records which vault the bridge was opened for: the vault the call really acted on.
    bridgeFor: (vaultId) => {
      bridgeVaults.push(vaultId);
      return client;
    },
    commandPolicy: () => ({ enabled: true, allowlist: ["editor:save-file"] }),
  });
  const ctx = (over: Partial<CallerContext> = {}): CallerContext => ({
    caller: CALLER,
    transport: "stdio",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: FIRST,
    db,
    acl: OPEN,
    ...over,
  });
  return {
    roots,
    db,
    registry,
    bridgeVaults,
    write,
    read: (vault: string, rel: string) => readFileSync(join(roots[vault] as string, rel), "utf8"),
    exists: (vault: string, rel: string) => {
      try {
        readFileSync(join(roots[vault] as string, rel));
        return true;
      } catch {
        return false;
      }
    },
    call: (name: string, input: Record<string, unknown>, over?: Partial<CallerContext>) =>
      registry.dispatch(name, input, ctx(over)),
    cleanup: () => {
      for (const r of Object.values(roots)) rmTemp(r);
    },
  };
}

type Booted = ReturnType<typeof boot>;
let live: Booted | undefined;
afterEach(() => {
  live?.cleanup();
  live = undefined;
});
function mk(): Booted {
  live = boot();
  return live;
}

interface Need {
  args_hash: string;
  tool: string;
  vault: string;
}
async function need(b: Booted, tool: string, input: Record<string, unknown>): Promise<Need> {
  const r = await b.call(tool, input);
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("expected elicit_required");
  expect(r.error.code).toBe("elicit_required");
  return r.error.details as unknown as Need;
}

/** What `obsidian-tc elicit` mints from the error's own text: its --vault and --hash. */
function mintFor(b: Booted, n: Need): string {
  const cfg = ServerConfigSchema.parse({
    vaults: [
      { id: FIRST, path: b.roots[FIRST] },
      { id: OTHER, path: b.roots[OTHER] },
    ],
  });
  const plan = planElicitMint(cfg, {
    vault: n.vault,
    tool: n.tool,
    hash: n.args_hash,
    caller: CALLER,
  } as never);
  return issueElicitToken(b.db, {
    vaultId: plan.vaultId,
    toolName: n.tool,
    argsHash: n.args_hash,
    caller: CALLER,
  });
}

// Each case: the tool, its input WITHOUT vault, and what proves it ran on a given vault.
const CASES = [
  {
    tool: "execute_command",
    input: { command_id: "editor:save-file" },
    ranOn: (b: Booted, v: string) => b.bridgeVaults.includes(v),
  },
  {
    tool: "trigger_quickadd",
    input: { action_name: "capture" },
    ranOn: (b: Booted, v: string) => b.bridgeVaults.includes(v),
  },
  {
    tool: "git_commit",
    input: { message: "snapshot" },
    ranOn: (b: Booted, v: string) => b.bridgeVaults.includes(v),
  },
  {
    tool: "delete_note",
    input: { path: "a.md" },
    ranOn: (b: Booted, v: string) => !b.exists(v, "a.md"),
  },
  {
    tool: "write_note",
    input: { path: "a.md", content: "new", mode: "overwrite" },
    ranOn: (b: Booted, v: string) => b.read(v, "a.md") === "new",
  },
] as const;

describe("hidden first vault on stdio: the confirmation names the vault the call acts on", () => {
  for (const c of CASES) {
    it(`${c.tool}: omitted vault -> elicit_required, mint command and redemption use the EFFECT vault`, async () => {
      const b = mk();
      b.write(FIRST, "a.md", "old");
      b.write(OTHER, "a.md", "old");
      const n = await need(b, c.tool, c.input);
      // (a) the error names the vault the call will act on, not ctx.vaultId.
      expect(n.vault).toBe(OTHER);
      const token = mintFor(b, n);
      // (b) the token minted from the error redeems, and the call lands on the vault it names.
      const res = await b.call(c.tool, c.input, { elicitToken: token });
      expect(res.ok).toBe(true);
      expect(c.ranOn(b, OTHER)).toBe(true);
      expect(c.ranOn(b, FIRST)).toBe(false);
    });

    it(`${c.tool}: a token minted for one vault does not redeem the same call on the other`, async () => {
      const b = mk();
      b.write(FIRST, "a.md", "old");
      b.write(OTHER, "a.md", "old");
      // Operator approves the call as it is shown (effect vault OTHER) ...
      const shown = await need(b, c.tool, c.input);
      const token = mintFor(b, shown);
      // ... and the token is presented on the same call aimed at the hidden first vault.
      const cross = await b.call(c.tool, { ...c.input, vault: FIRST }, { elicitToken: token });
      expect(cross.ok).toBe(false);
      if (!cross.ok) expect(cross.error.code).toBe("elicit_required");
      expect(c.ranOn(b, FIRST)).toBe(false);
      expect(c.ranOn(b, OTHER)).toBe(false);
      // ... and the mirror: a token minted for an explicit FIRST call cannot be spent on the default.
      const firstShown = await need(b, c.tool, { ...c.input, vault: FIRST });
      const firstToken = mintFor(b, firstShown);
      const back = await b.call(c.tool, c.input, { elicitToken: firstToken });
      expect(back.ok).toBe(false);
      expect(c.ranOn(b, OTHER)).toBe(false);
    });

    it(`${c.tool}: explicit vault != ctx.vaultId shows and mints the explicit vault`, async () => {
      const b = mk();
      b.write(FIRST, "a.md", "old");
      b.write(OTHER, "a.md", "old");
      const n = await need(b, c.tool, { ...c.input, vault: OTHER });
      expect(n.vault).toBe(OTHER);
      const res = await b.call(
        c.tool,
        { ...c.input, vault: OTHER },
        { elicitToken: mintFor(b, n) },
      );
      expect(res.ok).toBe(true);
      expect(c.ranOn(b, OTHER)).toBe(true);
    });
  }

  it("decline stays a hard stop: a call with no token is refused and runs nothing", async () => {
    const b = mk();
    b.write(OTHER, "a.md", "old");
    const r = await b.call("delete_note", { path: "a.md" });
    expect(r.ok).toBe(false);
    expect(b.exists(OTHER, "a.md")).toBe(true);
  });
});

describe("audit and idempotency follow the effect vault", () => {
  it("(d) the audit row carries the effect vault and the filled args", async () => {
    const b = mk();
    b.write(OTHER, "a.md", "old");
    const r = await b.call("read_note", { path: "a.md" });
    expect(r.ok).toBe(true);
    const row = b.db
      .prepare("SELECT vault_id, args_hash FROM event_log WHERE tool_name = 'read_note'")
      .get() as { vault_id: string; args_hash: string };
    expect(row.vault_id).toBe(OTHER);
    // The hash is over the arguments the call ran with, vault included: the explicit spelling of
    // the same call has the same hash.
    await b.call("read_note", { path: "a.md", vault: OTHER });
    const rows = b.db
      .prepare("SELECT args_hash FROM event_log WHERE tool_name = 'read_note'")
      .all() as Array<{ args_hash: string }>;
    expect(new Set(rows.map((x) => x.args_hash)).size).toBe(1);
  });

  it("(d) the idempotency claim is keyed on the effect vault", async () => {
    const b = mk();
    b.write(OTHER, "a.md", "old");
    const r = await b.call("idem_probe", { idempotency_key: "k-eff-1" });
    expect(r.ok).toBe(true);
    const rows = b.db.prepare("SELECT vault_id FROM idempotency_keys WHERE key = ?").all("k-eff-1");
    expect(rows).toEqual([{ vault_id: OTHER }]);
  });
});

describe("(e) a queued task job records the effect vault", () => {
  it("fills the omitted vault into the job's args at enqueue time", async () => {
    const b = mk();
    const queue = new JobQueue(b.db);
    const server = createMcpServer({
      name: "x",
      version: "0",
      registry: b.registry,
      context: () => ({
        caller: CALLER,
        transport: "stdio",
        authenticated: true,
        grantedScopes: new Set(["*"]),
        vaultId: FIRST,
        db: b.db,
        acl: OPEN,
      }),
      visibility: { grantedScopes: new Set(["*"]) },
      jobQueue: queue,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client(
      { name: "t", version: "0" },
      { capabilities: { extensions: { "io.modelcontextprotocol/tasks": {} } } as never },
    );
    await client.connect(ct);
    try {
      await client.callTool({ name: "task_probe", arguments: {} });
      const row = b.db
        .prepare("SELECT payload, vault_id FROM jobs WHERE type = 'mcp_tool_call'")
        .get() as { payload: string; vault_id: string } | undefined;
      expect(row).toBeDefined();
      expect(JSON.parse(row?.payload ?? "{}").args).toEqual({ vault: OTHER });
      // The owner (who may poll it) stays the caller's own identity.
      expect(row?.vault_id).toBe(FIRST);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
