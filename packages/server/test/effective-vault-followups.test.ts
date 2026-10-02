// Follow-ups to the per-call EFFECTIVE vault (dispatch rebinds ctx to the vault a call acts on).
// Both arise when that vault differs from the stdio session's own vault: the hidden-first-vault
// default, or an explicit `vault` that is not the session's.
//   1. The in-band form approval (requestState round trip) was sealed with the CALLER's vault, so
//      redemption against the effect vault refused it: the approved destructive call never ran.
//   2. The session JSONL trace dropped the call: the effect vault no longer matched the session row.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { finalizeConfig } from "../src/config/load";
import { provisionCacheDb } from "../src/db/provision";
import { elicitVerifier, getDefaultElicitTtlSeconds } from "../src/elicit";
import { createElicitCodec, type ElicitCodec } from "../src/elicit-request-state";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";
import { MetricsRecorder } from "../src/metrics/registry";
import { wireGovernance } from "../src/runtime/governance";
import { registerM1Tools } from "../src/tools/m1";
import { VaultRegistry } from "../src/vault/registry";
import { makeVisibleVaultIds } from "../src/vault/visible-vaults";
import { RERUN_SCOPES, rerunSession } from "../src/workspace/rerun";
import { insertSession, readTrace } from "../src/workspace/sessions";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const HIDDEN = new FolderAcl({ readOnly: false, defaultScopes: [], rules: [], readPaths: [] });
const OPEN = new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] });
const FIRST = "first"; // the stdio session's vault (ctx.vaultId)
const OTHER = "other"; // the vault the call acts on
const CALLER = "stdio";

type Mode = "hidden-default" | "explicit";

async function boot(mode: Mode) {
  const roots: Record<string, string> = {
    [FIRST]: makeTempDir("obtc-evf-first-"),
    [OTHER]: makeTempDir("obtc-evf-other-"),
  };
  for (const id of [FIRST, OTHER]) {
    mkdirSync(roots[id] as string, { recursive: true });
    writeFileSync(join(roots[id] as string, "a.md"), "old");
  }
  const db = openMemoryDb();
  provisionCacheDb(db);
  const vaultRegistry = new VaultRegistry(
    [FIRST, OTHER].map((id) => ({ id, name: id, path: roots[id] as string })),
  );
  const aclFor = (id: string): FolderAcl | undefined =>
    mode === "hidden-default" && id === FIRST ? HIDDEN : undefined;
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
  const real = createElicitCodec(randomBytes(32).toString("hex"), getDefaultElicitTtlSeconds());
  const minted: Array<{ vaultId: string; tool: string; argsHash: string }> = [];
  const codec: ElicitCodec = {
    ...real,
    mint: (payload) => {
      minted.push({ vaultId: payload.vaultId, tool: payload.tool, argsHash: payload.argsHash });
      return real.mint(payload);
    },
  };
  const server = createMcpServer({
    name: "obsidian-tc",
    version: "0.0.0-test",
    registry,
    context: () => ctx(),
    visibility: { grantedScopes: new Set(["*"]) },
    elicitCodec: codec,
    legacyElicitationShim: true,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const connect = async (action: "accept" | "decline") => {
    const client = new Client({ name: "t", version: "0" }, { capabilities: { elicitation: {} } });
    client.setRequestHandler(ElicitRequestSchema, async () =>
      action === "accept"
        ? { action: "accept", content: { approve: true } }
        : { action: "decline" },
    );
    await client.connect(ct);
    return client;
  };
  return {
    roots,
    db,
    registry,
    ctx,
    minted,
    connect,
    server,
    exists: (v: string, rel: string) => {
      try {
        readFileSync(join(roots[v] as string, rel));
        return true;
      } catch {
        return false;
      }
    },
    read: (v: string, rel: string) => readFileSync(join(roots[v] as string, rel), "utf8"),
    cleanup: () => {
      for (const r of Object.values(roots)) rmTemp(r);
    },
  };
}

type Booted = Awaited<ReturnType<typeof boot>>;
let live: Booted | undefined;
afterEach(() => {
  live?.cleanup();
  live = undefined;
});

const CASES = [
  {
    tool: "delete_note",
    args: { path: "a.md" },
    ranOn: (b: Booted, v: string) => !b.exists(v, "a.md"),
  },
  {
    tool: "write_note",
    args: { path: "a.md", content: "new", mode: "overwrite" },
    ranOn: (b: Booted, v: string) => b.read(v, "a.md") === "new",
  },
] as const;

describe("in-band form approval is sealed with the EFFECT vault", () => {
  for (const mode of ["hidden-default", "explicit"] as const) {
    for (const c of CASES) {
      it(`${mode} / ${c.tool}: approve -> the call lands on the effect vault, state sealed for it`, async () => {
        const b = await boot(mode);
        live = b;
        const client = await b.connect("accept");
        const args = mode === "explicit" ? { ...c.args, vault: OTHER } : { ...c.args };
        const res = await client.callTool({ name: c.tool, arguments: args });
        expect(res.isError).toBeFalsy();
        expect(c.ranOn(b, OTHER)).toBe(true);
        expect(c.ranOn(b, FIRST)).toBe(false);
        expect(b.minted.length).toBeGreaterThan(0);
        for (const m of b.minted) expect(m.vaultId).toBe(OTHER);
        // Confirmation telemetry pairs offer/answer with the episode on vault_id: all the effect vault.
        const rows = b.db
          .prepare("SELECT event_type, vault_id FROM event_log WHERE event_type LIKE 'hitl_%'")
          .all() as Array<{ event_type: string; vault_id: string }>;
        expect(rows.map((r) => r.event_type)).toEqual(
          expect.arrayContaining(["hitl_offered", "hitl_accept"]),
        );
        for (const r of rows) expect(r.vault_id).toBe(OTHER);
        await client.close();
        await b.server.close();
      });
    }
  }

  it("decline stays a hard stop on the effect vault: nothing runs, no mint route in the text", async () => {
    const b = await boot("hidden-default");
    live = b;
    const client = await b.connect("decline");
    const res = await client.callTool({ name: "delete_note", arguments: { path: "a.md" } });
    expect(res.isError).toBe(true);
    expect(b.exists(OTHER, "a.md")).toBe(true);
    expect(b.exists(FIRST, "a.md")).toBe(true);
    const text = (res.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(text).toContain("Do not retry it and do not mint a token.");
    expect(text).not.toContain("confirm with:");
    await client.close();
    await b.server.close();
  });

  for (const c of CASES) {
    it(`${c.tool}: a state sealed for vault A never authorizes the same call on vault B`, async () => {
      const b = await boot("explicit");
      live = b;
      const onB = { ...c.args, vault: OTHER };
      // The hash the gate itself demands for this call (a handler-side gate hashes its parsed input).
      const need = await b.registry.dispatch(c.tool, onB, b.ctx());
      expect(need.ok).toBe(false);
      if (need.ok) return;
      const sealedForA = {
        tool: c.tool,
        argsHash: (need.error.details as { args_hash: string }).args_hash,
        vaultId: FIRST,
        caller: CALLER,
      };
      const refused = await b.registry.dispatch(c.tool, onB, b.ctx({ elicitState: sealedForA }));
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.code).toBe("elicit_required");
      expect(c.ranOn(b, OTHER)).toBe(false);
      // Control: the same state sealed for B is accepted.
      const ok = await b.registry.dispatch(
        c.tool,
        onB,
        b.ctx({ elicitState: { ...sealedForA, vaultId: OTHER } }),
      );
      expect(ok.ok).toBe(true);
      expect(c.ranOn(b, OTHER)).toBe(true);
    });
  }
});

describe("session JSONL trace records a cross-vault call, with the effect vault noted", () => {
  it("a call on vault B under a session on vault A is traced in A's file with effect_vault", async () => {
    const cacheDir = makeTempDir("obtc-evf-cache-");
    const roots = { [FIRST]: makeTempDir("obtc-evf-t1-"), [OTHER]: makeTempDir("obtc-evf-t2-") };
    try {
      writeFileSync(join(roots[OTHER], "a.md"), "hello");
      writeFileSync(join(roots[FIRST], "x.md"), "hi");
      const cfg = finalizeConfig({
        vaults: [
          { id: FIRST, path: roots[FIRST] },
          { id: OTHER, path: roots[OTHER] },
        ],
        cacheDir,
      });
      const db = openMemoryDb();
      provisionCacheDb(db);
      const gov = wireGovernance({
        db,
        cacheDir,
        vaults: cfg.vaults,
        acl: cfg.acl,
        defaultVaultId: undefined,
        elicitTtlSeconds: cfg.elicitTtlSeconds,
        throttle: cfg.throttle,
        maxResponseBytes: cfg.governor.maxResponseBytes,
        idempotencyTtlSeconds: cfg.idempotencyTtlSeconds,
        idempotencyReclaimSeconds: cfg.idempotencyReclaimSeconds,
        toolVisibility: cfg.toolVisibility,
        metrics: new MetricsRecorder(),
        tracer: undefined,
        morgiana: { emit: () => {} },
        getAuditWriteFailureCounter: () => ({ auditWriteFailures: 0 }),
      });
      registerM1Tools(gov.registry, {
        vaultRegistry: gov.vaultRegistry,
        version: "test",
        startedAt: 0,
        embeddings: { provider: "ollama", model: "nomic-embed-text" },
      });
      const id = "sess_xvault";
      const row = insertSession(db, {
        id,
        vaultId: FIRST,
        caller: CALLER,
        startedAt: Date.now(),
        tracePath: `traces/${id}.jsonl`,
      });
      const ctx = (): CallerContext => ({
        caller: CALLER,
        transport: "stdio",
        authenticated: true,
        grantedScopes: new Set(["*"]),
        vaultId: FIRST,
        sessionId: id,
        db,
        acl: gov.acl,
      });
      const same = await gov.registry.dispatch("read_note", { vault: FIRST, path: "x.md" }, ctx());
      const cross = await gov.registry.dispatch("read_note", { vault: OTHER, path: "a.md" }, ctx());
      expect(same.ok).toBe(true);
      expect(cross.ok).toBe(true);
      const recs = readTrace(join(cacheDir, row.trace_path)).filter(
        (r) => r.type === "tool_invocation",
      );
      expect(recs).toHaveLength(2);
      const crossRec = recs.find((r) => r.effect_vault === OTHER);
      expect(crossRec?.tool).toBe("read_note");
      // The same-vault call carries no effect_vault noise.
      expect(recs.filter((r) => r.effect_vault === undefined)).toHaveLength(1);
      // A re-run is bound to the session's vault: the cross-vault record is refused by policy,
      // never reported as a divergence.
      const rerun = await rerunSession({
        replayScopes: RERUN_SCOPES,
        db,
        registry: gov.registry,
        sessionId: id,
        cacheDir,
        vaultRootFor: (v) => roots[v as keyof typeof roots],
      });
      const refused = rerun.records.filter((r) => r.verdict === "refused_by_policy");
      expect(refused).toHaveLength(1);
      expect(refused[0]?.reason).toContain(OTHER);
      expect(rerun.summary.diverged).toBe(0);
    } finally {
      rmTemp(cacheDir);
      for (const r of Object.values(roots)) rmTemp(r);
    }
  });
});
