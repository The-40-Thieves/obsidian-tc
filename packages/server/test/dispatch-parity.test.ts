// THE-600 / THE-514 — the cross-surface parity gate neither ticket found in the repo. Before
// this file: 0 hits for "transport parity" | "dispatch parity" | "all transports" |
// "every transport" | "both transports" | "same pipeline" across the codebase.
// `mcp-roundtrip.test.ts` and `http-roundtrip.test.ts` each prove their OWN transport reaches
// dispatch and audits; neither compares the two. Nothing compared the CLI's forget path (which
// bypasses dispatch entirely) against the MCP tool doing the same job. `resources.ts` growing its
// own hand-copied pipeline (THE-415, THE-514) is exactly the failure mode a gate like this exists
// to catch on the NEXT surface.
//
// FRAMING, deliberately: this gate asserts "every entry surface writes an audit row for a
// successful mutating operation" — NOT "every surface behaves identically". THE-600's own
// investigation (see its latest comment) found one INTENTIONAL divergence between work_forget and
// CLI forgetEpisode; a gate written as "assert sameness" would fail on that intentional difference
// and invite being relaxed until it stopped catching anything real. So intentional divergences are
// asserted explicitly, by name, with the reasoning inline (below) — not silently ignored, and not
// treated as a gate failure.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ObsidianTcError, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import { forgetEpisodeAudited, forgetNoteAudited } from "../src/cli/commands/forget";
import { runMigrations } from "../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { forgetEpisode, verifyForgetLog } from "../src/experiential/forget";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { readResource } from "../src/mcp/resources";
import { createMcpServer } from "../src/mcp/server";
import { registerM8Tools } from "../src/tools/m8";
import { startHttp } from "../src/transports/http";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";

const NOW = 1_700_000_000_000;

const readMigration = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");
const EXPERIENTIAL_CHAIN = EXPERIENTIAL_MIGRATION_FILES.map((file) => ({
  version: versionOf(file),
  sql: readMigration(file),
}));

function experientialDb(): Database {
  const db = openMemoryDb();
  runMigrations(db, EXPERIENTIAL_CHAIN);
  return db;
}

function seedEpisode(edb: Database, id: string): void {
  edb
    .prepare(
      `INSERT INTO agent_episodes (id, ts, caller, channel, episode_type, tool, status, eligibility, blocked, valid_from)
       VALUES (?, ?, 'tester', 'dispatch', 'tool_call', 'read_note', 'ok', 'eligible', 0, ?)`,
    )
    .run(id, NOW, NOW);
}

function eventLogRows(
  cacheDb: Database,
  toolName: string,
): Array<{ tool_name: string; status: string; args_hash: string }> {
  return cacheDb
    .prepare("SELECT tool_name, status, args_hash FROM event_log WHERE tool_name = ?")
    .all(toolName) as Array<{ tool_name: string; status: string; args_hash: string }>;
}

// ---------------------------------------------------------------------------------------------
// Section 1 — every MCP entry surface reaches the same dispatch pipeline and writes an
// audit_events (event_log) row for a successful mutating call.
// ---------------------------------------------------------------------------------------------

/** One MCP entry surface: boots its own transport against a SHARED registry/db pair and hands
 *  back a connected client. The calling code below (client.callTool) is IDENTICAL for every
 *  surface — only how the client gets connected differs, which is the point: this is one
 *  pipeline reached two ways, not two pipelines that happen to agree. */
interface Surface {
  name: string;
  boot(
    registry: ToolRegistry,
    cacheDb: Database,
  ): Promise<{ client: Client; close: () => Promise<void> }>;
}

const ENTRY_SURFACES: Surface[] = [
  {
    name: "mcp-stdio",
    async boot(registry, cacheDb) {
      const context = (): CallerContext => ({
        caller: "tester",
        authenticated: true,
        grantedScopes: new Set(["write:workspace"]),
        vaultId: "v1",
        db: cacheDb,
      });
      const server = createMcpServer({
        name: "obsidian-tc",
        version: "0.0.0-test",
        registry,
        context,
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "test-client", version: "0.0.0" });
      await client.connect(clientTransport);
      return {
        client,
        close: async () => {
          await client.close();
          await server.close();
        },
      };
    },
  },
  {
    name: "mcp-http",
    async boot(registry, cacheDb) {
      const handle = await startHttp({
        name: "obsidian-tc",
        version: "0.0.0-test",
        registry,
        auth: ServerConfigSchema.parse({
          vaults: [{ id: "v1", path: "/tmp/v1" }],
          auth: { mode: "none" },
        }).auth,
        db: cacheDb,
        vaultId: "v1",
        acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
        host: "127.0.0.1",
        port: 0,
      });
      const client = new Client({ name: "test-client", version: "0.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`)),
      );
      return {
        client,
        close: async () => {
          await client.close();
          await handle.close();
        },
      };
    },
  },
];

describe("cross-surface dispatch parity — audit row for a successful mutating call", () => {
  // Non-empty floor (reference-source-scan-gates): pin the exact surface count so a future refactor
  // that silently drops a surface from ENTRY_SURFACES (or a typo that empties it) fails loudly
  // instead of vacuously passing over zero surfaces. MCP stdio and MCP HTTP are the two production
  // transports that call `registry.dispatch(...)` today (mcp/server.ts:211, the CLI's `serve`
  // subcommand IS this stdio/HTTP host, not a third pipeline); the Obsidian plugin is not an
  // inbound transport (THE-514) and the CLI's other subcommands are the tracked, OUT-OF-SCOPE gap
  // this ticket explicitly does not fix (see the forget-specific section below for the one CLI
  // surface this gate DOES cover).
  it("floor: enumerates exactly the MCP entry surfaces that reach registry.dispatch", () => {
    expect(ENTRY_SURFACES.map((s) => s.name)).toEqual(["mcp-stdio", "mcp-http"]);
  });

  for (const surface of ENTRY_SURFACES) {
    it(`${surface.name}: a successful work_forget call writes an audit_events row`, async () => {
      const edb = experientialDb();
      const episodeId = `ep-${surface.name}`;
      seedEpisode(edb, episodeId);

      const cacheDb = openMemoryDb();
      provisionCacheDb(cacheDb);

      const registry = new ToolRegistry({});
      registerM8Tools(registry, { edb, now: () => NOW });

      const { client, close } = await surface.boot(registry, cacheDb);
      try {
        const res = await client.callTool({
          name: "work_forget",
          arguments: { episode_id: episodeId },
        });
        expect(res.isError ?? false).toBe(false);

        const rows = eventLogRows(cacheDb, "work_forget");
        expect(rows).toHaveLength(1);
        expect(rows[0]?.status).toBe("ok");
      } finally {
        await close();
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Section 2 — THE-600's documented exception. work_forget (the MCP tool) and CLI forgetEpisode
// share the THE-239 forget_log audit trail (as of PR #511) EXCEPT on one case, which is
// intentional and asserted here rather than treated as a defect.
// ---------------------------------------------------------------------------------------------

/** cli/commands/forget.ts's run_forget calls forgetEpisode directly with these exact semantics
 *  (no dispatch, no scope check). This section is scoped to the THE-239 forget_log trail only —
 *  calling forgetEpisode directly (rather than forgetEpisodeAudited) is deliberate here, so these
 *  forget_log-focused assertions don't also depend on cache.db/event_log plumbing. THE-605 closed
 *  the audit_events gap this comment used to describe as CLI-only and out of scope: see
 *  forgetEpisodeAudited/forgetNoteAudited (cli/commands/forget.ts, what run_forget actually calls
 *  today) and the "THE-605" section below, which pins the audit_events row those wrappers write
 *  to the SAME shape as dispatch's. Calling forgetEpisode here IS still exercising the CLI's
 *  forget_log semantics: it is the whole of what forgetEpisodeAudited does for `--episode`, minus
 *  the audit_events side effect this file's THE-605 section covers separately. */
function cliForget(edb: Database, id: string, nowMs: number) {
  return forgetEpisode(edb, id, { nowMs });
}

async function toolForget(edb: Database, id: string) {
  const registry = new ToolRegistry({});
  registerM8Tools(registry, { edb, now: () => NOW });
  const ctx: CallerContext = {
    caller: "tester",
    authenticated: true,
    grantedScopes: new Set(["write:workspace"]),
    vaultId: "v1",
    db: openMemoryDb(),
  };
  return registry.dispatch("work_forget", { episode_id: id }, ctx);
}

describe("THE-600 documented exception — work_forget vs CLI forgetEpisode forget_log parity", () => {
  it("fresh forget: BOTH surfaces write exactly one forget_log row", async () => {
    const toolDb = experientialDb();
    seedEpisode(toolDb, "e1");
    const toolRes = await toolForget(toolDb, "e1");
    expect(toolRes.ok && (toolRes.data as { forgotten: boolean }).forgotten).toBe(true);
    expect(verifyForgetLog(toolDb)).toEqual({ ok: true, entries: 1 });

    const cliDb = experientialDb();
    seedEpisode(cliDb, "e1");
    const cliRes = cliForget(cliDb, "e1", NOW);
    expect(cliRes.found).toBe(true);
    expect(verifyForgetLog(cliDb)).toEqual({ ok: true, entries: 1 });
  });

  // THE-600's latest comment, verbatim reasoning: work_forget is documented idempotent and called
  // by AGENTS, which retry — logging every repeat would let a retry loop grow the hash chain
  // without bound and make a replayed call indistinguishable from a genuine second forget attempt.
  // The chain should record EFFECTS, not INVOCATIONS; the dispatch audit_events row (section 1
  // above) already records the invocation for the tool surface. The CLI's opposite choice is also
  // defensible: a HUMAN operator re-running `obsidian-tc forget` on something already forgotten is
  // a small, bounded, arguably interesting event, and forget.test.ts asserts it on purpose
  // ("both audited, chain intact"). Two justified answers for two caller populations — NOT a bug,
  // and NOT something this gate should force into agreement.
  it("repeat forget on an already-blocked episode: CLI logs a row, work_forget does NOT (deliberate)", async () => {
    const toolDb = experientialDb();
    seedEpisode(toolDb, "e1");
    await toolForget(toolDb, "e1"); // first forget: 1 row
    const repeat = await toolForget(toolDb, "e1"); // repeat: no additional row
    expect(repeat.ok && (repeat.data as { forgotten: boolean }).forgotten).toBe(false);
    expect(verifyForgetLog(toolDb).entries).toBe(1); // NOT 2 — the tool suppresses the repeat

    const cliDb = experientialDb();
    seedEpisode(cliDb, "e1");
    cliForget(cliDb, "e1", NOW); // first forget: 1 row
    const cliRepeat = cliForget(cliDb, "e1", NOW + 1); // repeat: CLI logs it anyway
    expect(cliRepeat.already_blocked).toBe(true);
    expect(verifyForgetLog(cliDb).entries).toBe(2); // both audited, chain intact (forget.test.ts)
  });
});

// ---------------------------------------------------------------------------------------------
// Section 3 — THE-514 item 2. Vault-binding is a DELIBERATE, EVALUATED divergence between tool
// dispatch (conditional on ctx.vaultBound) and resources/read (unconditional), documented at
// mcp/registry.ts's vault-binding guard (search "AUTHORITATIVE NOTE") and mirrored at
// mcp/resources.ts's readResource. This asserts the documented STATE, not sameness — per THE-514's
// done-when: "the difference is deliberate and documented in one place."
// ---------------------------------------------------------------------------------------------

describe("THE-514 item 2 — vault-binding: documented divergence, asserted as such", () => {
  it("tool dispatch: an UNBOUND (trusted stdio) caller may name any configured vault", async () => {
    const registry = new ToolRegistry({});
    registry.register({
      name: "vault_echo_parity",
      description: "echoes the vault arg",
      inputSchema: z.object({ vault: z.string().optional() }),
      requiredScopes: [],
      handler: (i: { vault?: string }) => ({ vault: i.vault ?? null }),
    });
    const res = await registry.dispatch(
      "vault_echo_parity",
      { vault: "someone-elses-vault" },
      {
        caller: "t",
        authenticated: true,
        grantedScopes: new Set(["*"]),
        vaultId: "main",
        db: openMemoryDb(),
        // vaultBound intentionally absent — the trusted stdio shape.
      },
    );
    expect(res.ok).toBe(true); // conditional guard: unbound caller crosses vaults freely
  });

  it("resources/read: an UNBOUND caller is STILL refused a foreign-vault URI (unconditional)", () => {
    const cfg = ServerConfigSchema.parse({
      vaults: [
        { id: "main", path: "/tmp/otc-parity-main" },
        { id: "other", path: "/tmp/otc-parity-other" },
      ],
    });
    const vaultRegistry = new VaultRegistry(cfg.vaults);
    expect(() =>
      readResource(
        vaultRegistry,
        {
          caller: "t",
          authenticated: true,
          grantedScopes: new Set(["*"]),
          vaultId: "main",
          db: openMemoryDb(),
          // vaultBound intentionally absent, same as the tool test above — and it makes NO
          // difference here, which is exactly the documented divergence.
        },
        "obsidian-tc://other/secret.md",
        1_000_000,
      ),
    ).toThrow(/bound vault/);
  });
});

// ---------------------------------------------------------------------------------------------
// Section 4 — THE-514 item 1. Scope authorization (unlike vault binding) had NO semantic
// divergence to preserve: resources.ts's readResource and registry.ts's own scope gate both did
// `if (!grantsAll(...)) throw forbidden(...)`, just with resources.ts's copy missing
// `details.required`. registry.ts's `assertScopesGranted` now backs both call sites, so a missing
// scope produces the identical error shape (code + details.required) on either surface — proof
// the two reach the same step, not just two copies that happen to agree today.
// ---------------------------------------------------------------------------------------------

function tempVaultRegistry(): VaultRegistry {
  const dir = mkdtempSync(join(tmpdir(), "otc-parity-scope-"));
  writeFileSync(join(dir, "alpha.md"), "hello");
  return new VaultRegistry(
    ServerConfigSchema.parse({ vaults: [{ id: "main", path: dir }] }).vaults,
  );
}

describe("THE-514 item 1 — resources and tool-dispatch share one scope-authorization step", () => {
  it("a missing scope produces the SAME forbidden shape (code + details.required) on both surfaces", async () => {
    let resourceErr: unknown;
    try {
      readResource(
        tempVaultRegistry(),
        {
          caller: "t",
          authenticated: true,
          grantedScopes: new Set<string>(),
          vaultId: "main",
          db: openMemoryDb(),
        },
        "obsidian-tc://main/alpha.md",
        1_000_000,
      );
    } catch (e) {
      resourceErr = e;
    }
    expect(resourceErr).toBeInstanceOf(ObsidianTcError);
    const re = resourceErr as ObsidianTcError;
    expect(re.code).toBe("forbidden");
    expect(re.details).toMatchObject({ required: ["read:notes"] });

    const registry = new ToolRegistry({});
    registry.register({
      name: "scope_parity_probe",
      description: "THE-514 parity probe — requires read:notes like resources/read does",
      inputSchema: z.object({}),
      requiredScopes: ["read:notes"],
      handler: () => ({ ok: true }),
    });
    const res = await registry.dispatch(
      "scope_parity_probe",
      {},
      {
        caller: "t",
        authenticated: true,
        grantedScopes: new Set<string>(),
        vaultId: "main",
        db: openMemoryDb(),
      },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("forbidden");
      expect(res.error.details).toMatchObject({ required: ["read:notes"] });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Section 5 — THE-514 item 2. The byte-response ceiling (governor.maxResponseBytes) used to be a
// SECOND fixed copy in resources.ts, agreeing with registry.ts's configurable default but not
// wired to it. This asserts a single LOWERED ceiling now refuses an oversized response on BOTH
// surfaces — the natural home per [[reference-source-scan-gates]]: "both surfaces honour the same
// configured limit" is a genuine cross-surface invariant now, not just a tool one.
// ---------------------------------------------------------------------------------------------

describe("THE-514 item 2 — the same lowered maxResponseBytes refuses an oversized TOOL response and an oversized RESOURCE read", () => {
  it("refuses an oversized tool response", async () => {
    const registry = new ToolRegistry({ maxResponseBytes: 50 });
    registry.register({
      name: "oversized_echo_parity",
      description: "returns a payload over the configured ceiling",
      inputSchema: z.object({}),
      requiredScopes: [],
      handler: () => ({ text: "x".repeat(100) }),
    });
    const res = await registry.dispatch(
      "oversized_echo_parity",
      {},
      {
        caller: "t",
        authenticated: true,
        grantedScopes: new Set(["*"]),
        vaultId: "main",
        db: openMemoryDb(),
      },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("overflow");
  });

  it("the SAME registry's configured ceiling refuses an oversized resource read", () => {
    const dir = mkdtempSync(join(tmpdir(), "otc-parity-ceiling-"));
    writeFileSync(join(dir, "big.md"), "x".repeat(100));
    const vaultRegistry = new VaultRegistry(
      ServerConfigSchema.parse({ vaults: [{ id: "main", path: dir }] }).vaults,
    );
    const registry = new ToolRegistry({ maxResponseBytes: 50 });
    expect(() =>
      readResource(
        vaultRegistry,
        {
          caller: "t",
          authenticated: true,
          grantedScopes: new Set(["*"]),
          vaultId: "main",
          db: openMemoryDb(),
        },
        "obsidian-tc://main/big.md",
        // THE-514 item 2: this is exactly what mcp/server.ts now passes — the registry's OWN
        // configured ceiling, not a hardcoded resources.ts constant.
        registry.maxResponseBytes,
      ),
    ).toThrow(/exceeds 50 bytes/);
  });
});

// ---------------------------------------------------------------------------------------------
// Section 6 — THE-605. `forget`'s new direct `audit_events` writer (`forgetEpisodeAudited` /
// `forgetNoteAudited`, cli/commands/forget.ts) is a SECOND producer of the table dispatch's
// `recordOutcome` writes (mcp/registry.ts:660) — exactly the duplication pattern THE-600/THE-514
// both exist to reduce. The objection to a second producer is answered here, by a gate, not by
// hoping: this pins the CLI's row to the SAME shape (same columns, same JS types) as a dispatch
// row, so a refactor that silently drops or renames a column on one writer and not the other
// fails HERE, not on a customer's audit trail. Per this file's own framing (top of file): this
// asserts STRUCTURE, not sameness — tool_name/caller/args_hash legitimately differ between "an
// agent called work_forget" and "an operator ran `obsidian-tc forget`".
// ---------------------------------------------------------------------------------------------

function eventLogRow(cacheDb: Database, toolName: string): Record<string, unknown> {
  const row = cacheDb
    .prepare(
      "SELECT ts, vault_id, tool_name, caller, duration_ms, result_size, status, error_code, args_hash, event_type FROM event_log WHERE tool_name = ?",
    )
    .get(toolName) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`no event_log row for tool_name=${toolName}`);
  return row;
}

describe("THE-605 — CLI forget's audit_events row matches dispatch's shape", () => {
  it("forgetEpisodeAudited (CLI) writes the same column set and types as registry.dispatch's recordOutcome", async () => {
    // Dispatch side: a real work_forget call through registry.dispatch (Section 1's own pattern).
    const dispatchCache = openMemoryDb();
    provisionCacheDb(dispatchCache);
    const dispatchEdb = experientialDb();
    seedEpisode(dispatchEdb, "ep-dispatch");
    const registry = new ToolRegistry({});
    registerM8Tools(registry, { edb: dispatchEdb, now: () => NOW });
    const dispatchRes = await registry.dispatch(
      "work_forget",
      { episode_id: "ep-dispatch" },
      {
        caller: "tester",
        authenticated: true,
        grantedScopes: new Set(["write:workspace"]),
        vaultId: "v1",
        db: dispatchCache,
      },
    );
    expect(dispatchRes.ok).toBe(true);
    const dispatchRow = eventLogRow(dispatchCache, "work_forget");

    // CLI side: the same kind of successful, content-destroying forget, via forgetEpisodeAudited —
    // what run_forget actually calls today for `--episode` (cli/commands/forget.ts).
    const cliCache = openMemoryDb();
    provisionCacheDb(cliCache);
    const cliEdb = experientialDb();
    seedEpisode(cliEdb, "ep-cli");
    const cliRes = forgetEpisodeAudited(cliEdb, cliCache, "v1", "ep-cli", { nowMs: NOW });
    expect(cliRes.found).toBe(true);
    const cliRow = eventLogRow(cliCache, "forget");

    // Same columns present, order-independent.
    expect(Object.keys(cliRow).sort()).toEqual(Object.keys(dispatchRow).sort());
    // Same JS type per column — a writer that started emitting a number where the other emits a
    // string (or vice versa) fails here even though both rows "have" the column.
    for (const key of Object.keys(dispatchRow)) {
      expect(typeof cliRow[key]).toBe(typeof dispatchRow[key]);
    }
    // Both are a "tool ran" event — audit_events answering "an operation ran" (THE-605), not one
    // of event_log's other event_type shapes (sweep_run, snapshot_skipped, ...).
    expect(dispatchRow.event_type).toBe("tool_invocation");
    expect(cliRow.event_type).toBe("tool_invocation");
  });
});

// ---------------------------------------------------------------------------------------------
// Section 7 — THE-609. WHEN each audit surface writes, as opposed to Section 6's WHAT it writes.
//
// The rule, and the whole of it: **audit_events mirrors forget_log.** A row lands on one exactly
// when a row lands on the other.
//
// This was not true. `forgetNoteAudited` gated its audit row on `chunk_ids.length > 0`, reasoning
// that a never-indexed path "touches nothing". It does: `forgetNote` appends to THE-239's
// tamper-evident hash chain OUTSIDE its own chunkIds guard, inside the transaction that always
// commits (experiential/forget.ts), and may also rmSync prewarm files. So a no-op forget left a
// permanent forget_log entry and NOTHING in audit_events — an operator reading one surface saw an
// operation the other denied. THE-605 item 2 required the audit row even when forget_log is
// written, and THE-600 established that having one is not having the other.
//
// The note/episode asymmetry below is the rule holding, not an exception to it: a missing episode
// returns before forgetEpisode opens its transaction, so it appends no forget_log row either.
// These tests exist so the next reader finds the decision rather than re-deriving the discrepancy.
// ---------------------------------------------------------------------------------------------

describe("THE-609 — audit_events mirrors forget_log, including on a no-op", () => {
  it("writes an audit row for a NEVER-INDEXED note, because forget_log gets one too", () => {
    const cacheDb = openMemoryDb();
    provisionCacheDb(cacheDb);
    const edb = experientialDb();

    const r = forgetNoteAudited(edb, cacheDb, {
      vaultId: "v1",
      relPath: "never/indexed.md",
      nowMs: NOW,
    });

    // Precondition: this really is the no-op case the old guard suppressed. Without this the test
    // could pass against an indexed path and prove nothing about the branch under test.
    expect(r.chunk_ids).toEqual([]);

    // The hash chain recorded it — with chunks: 0, which is the honest count, not an absence.
    const chain = edb
      .prepare("SELECT kind, target, details FROM forget_log WHERE target = ?")
      .get("never/indexed.md") as { kind: string; target: string; details: string } | undefined;
    expect(chain?.kind).toBe("note");
    expect(JSON.parse(chain?.details ?? "{}").chunks).toBe(0);

    // ...and so did audit_events. This is the assertion that fails on the pre-THE-609 code.
    const audit = cacheDb
      .prepare("SELECT tool_name, event_type FROM event_log WHERE tool_name = ?")
      .get("forget") as { tool_name: string; event_type: string } | undefined;
    expect(audit?.event_type).toBe("tool_invocation");
  });

  it("writes NEITHER record for a missing episode — the same rule, not an exception", () => {
    // forgetEpisode returns before opening its transaction, so there is no hash-chain append to
    // mirror. Keeping the `r.found` gate is therefore consistent with the note path, not a
    // leftover: both writers key on "did a forget_log row happen".
    const cacheDb = openMemoryDb();
    provisionCacheDb(cacheDb);
    const edb = experientialDb();

    const r = forgetEpisodeAudited(edb, cacheDb, "v1", "ep-does-not-exist", { nowMs: NOW });
    expect(r.found).toBe(false);

    expect((edb.prepare("SELECT COUNT(*) AS n FROM forget_log").get() as { n: number }).n).toBe(0);
    expect((cacheDb.prepare("SELECT COUNT(*) AS n FROM event_log").get() as { n: number }).n).toBe(
      0,
    );
  });
});
