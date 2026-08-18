// THE-132 — vault_context. Pins the composite contract: engine ordering preserved, greedy
// budget packing (85% chunk share), note grouping, the contradiction + synthesis legs, and
// the include_work leg honoring the THE-229 reader contract (explicit opt-in; eligible-only;
// work_unavailable without the experiential handle). Uses the lexical route (classRouter +
// rare term) so no embedding backend is needed — same dispatch path as serve.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { ToolRegistry } from "../src/mcp/registry";
import { ensureChunkFts } from "../src/search/chunk_fts";
import { callerAclFingerprint, prewarmPathFor, writePrewarm } from "../src/search/prefetch";
import { registerM7Tools } from "../src/tools/m7";
import { packBudget } from "../src/tools/m7/knowledge-tools";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { rmTemp } from "./tmp";

const expSql = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260626_001_experiential_init.sql", import.meta.url)),
  "utf8",
);
const episodesSql = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260711_002_agent_episodes.sql", import.meta.url)),
  "utf8",
);
const outcomeSql = readFileSync(
  fileURLToPath(
    new URL("../src/migrations/20260711_001_experiential_outcome.sql", import.meta.url),
  ),
  "utf8",
);
const NOW = 1_700_000_000_000;
// The test harness's ctx never sets ctx.acl, so every prewarm entry it writes/reads here is
// under the "no-acl" caller identity (THE-543's callerAclFingerprint sentinel).
const NO_ACL_FP = callerAclFingerprint(undefined, ["read:notes"]);

function cacheDb0(): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const ins = db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, 'main', ?, ?, '[]', ?, ?, ?, ?, ?)",
  );
  // Two chunks of the rare-term note (grouping) + one other note also carrying the term.
  ins.run(
    "r1",
    "notes/rare.md",
    "0",
    "the zylophrastic reconciler pattern part one",
    "h1",
    40,
    NOW,
    NOW,
  );
  ins.run(
    "r2",
    "notes/rare.md",
    "1",
    "zylophrastic reconciler details part two",
    "h2",
    40,
    NOW,
    NOW,
  );
  ins.run(
    "o1",
    "notes/other.md",
    "0",
    "zylophrastic mention in another note entirely",
    "h3",
    40,
    NOW,
    NOW,
  );
  // THE-231: a lesson-class chunk (decision-note path). Carries only "reconciler" so the
  // rare-term df of "zylophrastic" stays at 3 (the lexical route's ceiling); FTS tokens are
  // OR'd, so it still matches the two-term query for the lessons backfill.
  ins.run(
    "d1",
    "09-reference/decisions/2026-06-20-zylo-choice.md",
    "0",
    "decision: adopt the reconciler despite the cost",
    "h4",
    40,
    NOW,
    NOW,
  );
  ensureChunkFts(db, { now: () => NOW, enrich: false });
  // The plane tables (contradictions, syntheses) come from the migration chain now. This fixture used
  // to CREATE its own, looser versions — missing five NOT NULL columns and using a judge_verdict value
  // ('conflict') that the real schema does not define — so these legs were never exercised against the
  // shape production actually has. The rows below satisfy the real constraints.
  db.prepare(
    "INSERT INTO contradictions (id, vault_id, source_chunk_id, source_path, conflict_chunk_id, conflict_path, source_content_sha, conflict_content_sha, judge_verdict, judge_rationale, status, detected_at) VALUES ('cx1', 'main', 'c-src', 'notes/rare.md', 'c-cfl', 'notes/other.md', 'sha-src', 'sha-cfl', 'contradiction', 'they disagree', 'open', ?)",
  ).run(NOW);
  db.prepare(
    "INSERT INTO syntheses (vault_id, iso_year, iso_week, generated_at, cluster_count, pattern_count, clusters, patterns) VALUES ('main', 2026, 27, ?, 0, 1, '[]', ?)",
  ).run(NOW, JSON.stringify(["zylophrastic reconciliation is weekly"]));
  return db;
}

function edb0(): Database {
  const db = openMemoryDb();
  runMigrations(db, [
    { version: "20260626_001", sql: expSql },
    { version: "20260711_001", sql: outcomeSql },
    { version: "20260711_002", sql: episodesSql },
  ]);
  db.prepare(
    "INSERT INTO agent_episodes (id, ts, session_id, caller, channel, episode_type, tool, status, eligibility, trust, blocked, valid_from) VALUES ('ep-ok', ?, NULL, 'tester', 'dispatch', 'tool_call', 'read_note', 'ok', 'eligible', 0.6, 0, ?)",
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO agent_episodes (id, ts, session_id, caller, channel, episode_type, tool, status, eligibility, trust, blocked, valid_from) VALUES ('ep-pending', ?, NULL, 'tester', 'dispatch', 'tool_call', 'read_note', 'ok', 'pending', 0.6, 0, ?)",
  ).run(NOW, NOW);
  return db;
}

function un<T>(r: unknown): T {
  return (r as { data: T }).data;
}

const root = mkdtempSync(join(tmpdir(), "obtc-vc-"));
afterAll(() => rmTemp(root));

function harness(edb?: Database, rootOverride?: string, prewarmDir?: string) {
  const cache = cacheDb0();
  const registry = new ToolRegistry({});
  const vaultRegistry = new VaultRegistry([
    { id: "main", name: "main", path: rootOverride ?? root },
  ]);
  const embeddingProvider = {
    provider: "ollama",
    model: "stub",
    dimensions: 768,
    embed: async () => {
      throw new Error("embed must not be called on the lexical route");
    },
  };
  registerM7Tools(registry, {
    vaultRegistry,
    embeddingProvider: embeddingProvider as any,
    reranker: null,
    roles: null,
    classRouter: true,
    ...(edb ? { edb } : {}),
    ...(prewarmDir ? { prewarmDir } : {}),
  });
  const ctx = {
    caller: "tester",
    authenticated: true,
    grantedScopes: new Set(["read:notes"]),
    vaultId: "main",
    db: cache,
  };
  return { registry, ctx };
}

interface ContextData {
  route: string[];
  query_source: string;
  signal?: string;
  budget: { requested: number; chunk_budget: number; packed_tokens: number };
  stats: { chunks_considered: number; chunks_packed: number; notes: number };
  notes: Array<{ path: string; chunks: Array<{ chunk_id: string }> }>;
  syntheses: Array<{ iso_year: number; iso_week: number; patterns: unknown }>;
  contradictions: Array<{ id: string }>;
  lessons: Array<{ chunk_id: string; path: string; via: string }>;
  episodes?: Array<{ id: string }> | { work_unavailable: true };
  diff_since?: string;
}

describe("vault_context (THE-132)", () => {
  it("packs to budget, groups by note, and returns the composite legs", async () => {
    const { registry, ctx } = harness();
    const res = un<ContextData>(
      await registry.dispatch(
        "vault_context",
        { vault: "main", query: "zylophrastic reconciler", token_budget: 4000 },
        ctx,
      ),
    );
    expect(res.route.some((s) => s.startsWith("rare-term:zylophrastic"))).toBe(true);
    expect(res.query_source).toBe("input");
    expect(res.stats.chunks_packed).toBe(4);
    // THE-231: the decision-note chunk surfaces as an applicable lesson.
    expect(res.lessons.map((l) => l.chunk_id)).toContain("d1");
    // consecutive same-note chunks grouped
    const rare = res.notes.find((n) => n.path === "notes/rare.md");
    expect(rare?.chunks.length).toBeGreaterThanOrEqual(1);
    expect(res.notes.length).toBeLessThanOrEqual(4);
    // contradiction on a packed note surfaces
    expect(res.contradictions.map((c) => c.id)).toContain("cx1");
    // synthesis LIKE-matched on a significant query token
    expect(res.syntheses).toHaveLength(1);
    expect(res.syntheses[0]?.iso_year).toBe(2026);
    // budget accounting
    expect(res.budget.chunk_budget).toBe(3400);
    expect(res.budget.packed_tokens).toBeLessThanOrEqual(res.budget.chunk_budget);
    expect(res.episodes).toBeUndefined(); // include_work defaults off
  });

  it("a binding budget cuts the packed set in engine order", async () => {
    const { registry, ctx } = harness();
    const res = un<ContextData>(
      await registry.dispatch(
        "vault_context",
        { vault: "main", query: "zylophrastic reconciler", token_budget: 60 },
        ctx,
      ),
    );
    // 85% of 60 = 51 tokens -> first chunk (40) fits, second (40) does not.
    expect(res.stats.chunks_packed).toBe(1);
    expect(res.budget.packed_tokens).toBeLessThanOrEqual(51);
  });

  it("include_work honors the reader contract; unavailable without the handle", async () => {
    const noEdb = harness();
    const off = un<ContextData>(
      await noEdb.registry.dispatch(
        "vault_context",
        { vault: "main", query: "zylophrastic", include_work: true },
        noEdb.ctx,
      ),
    );
    expect(off.episodes).toEqual({ work_unavailable: true });

    const withEdb = harness(edb0());
    const on = un<ContextData>(
      await withEdb.registry.dispatch(
        "vault_context",
        { vault: "main", query: "zylophrastic", include_work: true },
        withEdb.ctx,
      ),
    );
    const eps = on.episodes as Array<{ id: string }>;
    expect(eps.map((e) => e.id)).toEqual(["ep-ok"]); // eligible-only; pending never surfaces
  });

  it("include_lessons: false suppresses the lessons leg", async () => {
    const { registry, ctx } = harness();
    const res = un<ContextData>(
      await registry.dispatch(
        "vault_context",
        { vault: "main", query: "zylophrastic reconciler", include_lessons: false },
        ctx,
      ),
    );
    expect(res.lessons).toEqual([]);
  });

  it("bootstrap mode: no query reads the next-session signal note (THE-231)", async () => {
    const root2 = mkdtempSync(join(tmpdir(), "obtc-vc-boot-"));
    mkdirSync(join(root2, "memory"), { recursive: true });
    writeFileSync(
      join(root2, "memory", "_next-session.md"),
      "---\ntags: [thread]\n---\nresume the zylophrastic reconciler migration thread",
    );
    try {
      const { registry, ctx } = harness(undefined, root2);
      const res = un<ContextData>(await registry.dispatch("vault_context", { vault: "main" }, ctx));
      expect(res.query_source).toBe("next_session");
      expect(res.signal).toBe("memory/_next-session.md");
      expect(res.stats.chunks_packed).toBeGreaterThan(0);
      expect(res.lessons.map((l) => l.chunk_id)).toContain("d1");
    } finally {
      rmTemp(root2);
    }
  });

  it("bootstrap serves a fresh prewarm entry without recomposing (THE-136)", async () => {
    const root4 = mkdtempSync(join(tmpdir(), "obtc-vc-warm-"));
    const warmDir = mkdtempSync(join(tmpdir(), "obtc-warm-"));
    mkdirSync(join(root4, "memory"), { recursive: true });
    // "zylo thread" routes STANDARD (df=0 tokens) — a live compose would hit the throwing
    // embed stub, so a successful response proves the cache served it.
    writeFileSync(join(root4, "memory", "_next-session.md"), "zylo thread");
    const hash = createHash("sha256").update("zylo thread").digest("hex");
    writePrewarm(prewarmPathFor(warmDir, "main", NO_ACL_FP), {
      generated_at: 111,
      expires_at: Date.now() + 60_000,
      signal: "memory/_next-session.md",
      signal_hash: hash,
      empty: false,
      // THE-417: a REALISTIC bundle, not a `{ sentinel: true }` marker. vault_context now declares
      // an outputSchema, and the prefetch path validates the cached bundle against it — a stored
      // entry whose shape does not match what the tool returns today is treated as a MISS (layer 4,
      // alongside the existing ACL and generation layers). A sentinel object is exactly the stale
      // shape that check exists to reject, so the fixture has to be a real response.
      //
      // `prefetched` + `prefetch_generated_at` are what prove the cache served this: the handler
      // only adds them on the cache-hit path, and a live compose here would hit the throwing embed
      // stub. The old sentinel assertion was belt-and-braces on top of that.
      bundle: {
        vault: "main",
        route: [],
        query_source: "next_session",
        budget: { requested: 4000, chunk_budget: 4000, packed_tokens: 12 },
        stats: {
          chunks_considered: 1,
          chunks_packed: 1,
          notes: 1,
          contradictions: 0,
          syntheses: 0,
          lessons: 0,
        },
        notes: [{ path: "a.md", chunks: [{ chunk_id: "c1", score: 1, source: "seed", hop: 0 }] }],
        syntheses: [],
        contradictions: [],
        lessons: [],
      },
      acl_fingerprint: NO_ACL_FP,
      vault_generation: 0,
    });
    try {
      const { registry, ctx } = harness(undefined, root4, warmDir);
      const res = un<{ vault?: string; prefetched?: boolean; prefetch_generated_at?: number }>(
        await registry.dispatch("vault_context", { vault: "main" }, ctx),
      );
      expect(res.vault).toBe("main");
      expect(res.prefetched).toBe(true);
      expect(res.prefetch_generated_at).toBe(111);
    } finally {
      rmTemp(root4);
      rmTemp(warmDir);
    }
  });

  it("expired and empty prewarm entries fall through to a live compose + write-through", async () => {
    const root5 = mkdtempSync(join(tmpdir(), "obtc-vc-stale-"));
    const warm5 = mkdtempSync(join(tmpdir(), "obtc-warm5-"));
    mkdirSync(join(root5, "memory"), { recursive: true });
    const signalText = "resume the zylophrastic reconciler migration thread";
    writeFileSync(join(root5, "memory", "_next-session.md"), signalText);
    const hash = createHash("sha256").update(signalText).digest("hex");
    const file = prewarmPathFor(warm5, "main", NO_ACL_FP);
    // Expired entry: reader must refuse it (the FlowState bug) and compose live.
    writePrewarm(file, {
      generated_at: 5,
      expires_at: 10,
      signal: "memory/_next-session.md",
      signal_hash: hash,
      empty: false,
      bundle: { sentinel: true },
      acl_fingerprint: NO_ACL_FP,
      vault_generation: 0,
    });
    try {
      const { registry, ctx } = harness(undefined, root5, warm5);
      const live = un<ContextData & { prefetched?: boolean }>(
        await registry.dispatch("vault_context", { vault: "main" }, ctx),
      );
      expect(live.prefetched).toBeUndefined();
      expect(live.query_source).toBe("next_session");
      expect(live.stats.chunks_packed).toBeGreaterThan(0);
      // Write-through refreshed the file with the live bundle.
      const refreshed = JSON.parse(readFileSync(file, "utf8"));
      expect(refreshed.generated_at).toBeGreaterThan(5);
      expect(refreshed.empty).toBe(false);
      expect(refreshed.bundle?.query_source).toBe("next_session");

      // Fresh EMPTY marker (the prefetch floor): also a miss — live compose again.
      writePrewarm(file, {
        generated_at: 7,
        expires_at: Date.now() + 60_000,
        signal: "memory/_next-session.md",
        signal_hash: hash,
        empty: true,
        acl_fingerprint: NO_ACL_FP,
        vault_generation: 0,
      });
      const again = un<ContextData & { prefetched?: boolean }>(
        await registry.dispatch("vault_context", { vault: "main" }, ctx),
      );
      expect(again.prefetched).toBeUndefined();
      expect(again.stats.chunks_packed).toBeGreaterThan(0);
    } finally {
      rmTemp(root5);
      rmTemp(warm5);
    }
  });

  it("no query and no signal note is invalid_input", async () => {
    const root3 = mkdtempSync(join(tmpdir(), "obtc-vc-empty-"));
    try {
      const { registry, ctx } = harness(undefined, root3);
      const r = (await registry.dispatch("vault_context", { vault: "main" }, ctx)) as {
        ok: boolean;
        error?: { code?: string };
      };
      expect(r.ok).toBe(false);
    } finally {
      rmTemp(root3);
    }
  });

  // THE-647 item 1: differential vault_context.
  describe("since (differential mode)", () => {
    it("is accepted by the .strict() schema and filters legs to rows newer than the cutoff", async () => {
      const { registry, ctx } = harness();
      const since = new Date(NOW - 1000).toISOString();
      const res = un<ContextData>(
        await registry.dispatch(
          "vault_context",
          { vault: "main", query: "zylophrastic reconciler", since },
          ctx,
        ),
      );
      expect(res.diff_since).toBeDefined();
      expect(res.notes.length).toBeGreaterThan(0);
      expect(res.syntheses).toHaveLength(1);
      expect(res.contradictions.map((c) => c.id)).toContain("cx1");
    });

    it("a since in the future returns an empty diff — no rejection, just nothing new", async () => {
      const { registry, ctx } = harness();
      const since = new Date(NOW + 1000).toISOString();
      const res = un<ContextData>(
        await registry.dispatch(
          "vault_context",
          { vault: "main", query: "zylophrastic reconciler", since },
          ctx,
        ),
      );
      expect(res.notes).toEqual([]);
      expect(res.syntheses).toEqual([]);
      expect(res.contradictions).toEqual([]);
    });

    it("include_work: since also filters the episodes leg", async () => {
      const { registry, ctx } = harness(edb0());
      const before = un<ContextData>(
        await registry.dispatch(
          "vault_context",
          {
            vault: "main",
            query: "zylophrastic",
            include_work: true,
            since: new Date(NOW - 1000).toISOString(),
          },
          ctx,
        ),
      );
      expect((before.episodes as Array<{ id: string }>).map((e) => e.id)).toEqual(["ep-ok"]);

      const after = un<ContextData>(
        await registry.dispatch(
          "vault_context",
          {
            vault: "main",
            query: "zylophrastic",
            include_work: true,
            since: new Date(NOW + 1000).toISOString(),
          },
          ctx,
        ),
      );
      expect(after.episodes).toEqual([]);
    });

    it("omitting since is unchanged: no diff_since echo, no watermark persisted", async () => {
      const { registry, ctx } = harness();
      const res = un<ContextData>(
        await registry.dispatch(
          "vault_context",
          { vault: "main", query: "zylophrastic reconciler" },
          ctx,
        ),
      );
      expect(res.diff_since).toBeUndefined();
      const row = ctx.db
        .prepare("SELECT watermark FROM vault_context_watermark WHERE caller = ? AND vault_id = ?")
        .get("tester", "main");
      expect(row).toBeUndefined();
    });

    it("persists a per-caller watermark, captured before the read, that a next call resumes from without dropping a concurrent write", async () => {
      const { registry, ctx } = harness();
      const first = un<ContextData>(
        await registry.dispatch(
          "vault_context",
          {
            vault: "main",
            query: "zylophrastic reconciler",
            since: new Date(NOW - 1000).toISOString(),
          },
          ctx,
        ),
      );
      expect(first.diff_since).toBeDefined();
      const row = ctx.db
        .prepare("SELECT watermark FROM vault_context_watermark WHERE caller = ? AND vault_id = ?")
        .get("tester", "main") as { watermark: number };
      expect(row.watermark).toBe(Date.parse(first.diff_since as string));

      // A synthesis generated AFTER the first call's watermark was captured — the case this
      // ticket's own AC3 names: a row written concurrently with a diff call. The syntheses leg
      // is queried independently of the packed notes (unlike contradictions, which is scoped to
      // paths actually returned this call), so it isolates the watermark discipline itself.
      ctx.db
        .prepare(
          "INSERT INTO syntheses (vault_id, iso_year, iso_week, generated_at, cluster_count, pattern_count, clusters, patterns) VALUES ('main', 2026, 28, ?, 0, 1, '[]', ?)",
        )
        .run(row.watermark + 500, JSON.stringify(["a late-breaking pattern"]));

      // The next call resumes from the ECHOED diff_since — not skipped.
      const second = un<ContextData>(
        await registry.dispatch(
          "vault_context",
          { vault: "main", query: "zylophrastic reconciler", since: first.diff_since },
          ctx,
        ),
      );
      expect(second.syntheses.map((s) => s.iso_year)).toContain(2026);
      expect(second.syntheses.some((s) => s.iso_week === 28)).toBe(true);
    });
  });

  it("packBudget: greedy, budget-bound, always packs at least one item", () => {
    const items = [10, 20, 30, 40];
    expect(packBudget(items, (n) => n, 35)).toEqual({ packed: [10, 20], tokens: 30 });
    expect(packBudget(items, (n) => n, 5)).toEqual({ packed: [10], tokens: 10 });
    expect(packBudget([], (n: number) => n, 100)).toEqual({ packed: [], tokens: 0 });
  });
});
