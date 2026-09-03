import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { compileEgressFilter } from "../src/plane/egress-filter";
import type { GatewayRoles } from "../src/plane/gateway";
import { isoWeek, parseSynthesis, planSynthesis, runSynthesis } from "../src/plane/jobs/synthesis";
import { openMemoryDb } from "./helpers";

const INIT = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);

function rolesReturning(text: string): GatewayRoles {
  const r = async () => ({ text, model: "mock" });
  return { extract: r, synthesize: async () => ({ text, model: "opus" }), judge: r };
}

function withChunksDb(): Database {
  const db = openMemoryDb();
  runMigrations(db, [{ version: "20260519_001", sql: INIT }]);
  db.exec(
    "CREATE TABLE syntheses (vault_id TEXT NOT NULL, iso_year INTEGER NOT NULL, iso_week INTEGER NOT NULL, generated_at INTEGER NOT NULL, cluster_count INTEGER NOT NULL, pattern_count INTEGER NOT NULL, clusters TEXT NOT NULL, patterns TEXT NOT NULL, judge_model TEXT, PRIMARY KEY (vault_id, iso_year, iso_week));",
  );
  return db;
}

describe("synthesis job (kb-synthesis-worker collapse)", () => {
  it("isoWeek computes the ISO 8601 week (UTC)", () => {
    expect(isoWeek(new Date(Date.UTC(2026, 0, 1))).year).toBe(2026);
  });

  it("parseSynthesis requires patterns + clusters arrays", () => {
    expect(() => parseSynthesis("{}")).toThrow();
    expect(parseSynthesis('{"patterns":[],"clusters":[]}').patterns).toEqual([]);
  });

  // THE-663 follow-up / prod incident 2026-08-02: the synthesis job 400'd on every run with
  // litellm.ContextWindowExceededError. RECENT_LIMIT=200 chunks x CONTENT_TRUNCATE=1000 chars is a
  // PER-ITEM cap with no aggregate bound, so the built prompt reached 169,258 chars against a
  // 32,768-token window. Measured on the live vault: 3.29 chars/token, so that prompt was ~51.4k
  // tokens — 57% over. A per-item cap is not a budget.
  it("bounds the TOTAL prompt, not just each chunk (context-overflow regression)", async () => {
    const db = withChunksDb();
    // 200 chunks x 1000 chars each = 200,000 chars of content alone, all under the per-item cap.
    for (let i = 0; i < 200; i++) {
      db.prepare(
        "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, 'v1', ?, '0', '[]', ?, ?, 1, 0, ?)",
      ).run(`c${i}`, `N${i}.md`, "x".repeat(1000), `h${i}`, i);
    }
    let seen = 0;
    const roles: GatewayRoles = {
      extract: async () => ({ text: "", model: "m" }),
      judge: async () => ({ text: "", model: "m" }),
      synthesize: async (req) => {
        seen = req.messages.map((m) => m.content).join("").length;
        return { text: '{"patterns":[],"clusters":[]}', model: "m" };
      },
    };
    const res = await runSynthesis({ db, roles, now: () => 0, maxPromptChars: 20_000 });
    expect(res.ok).toBe(true);
    // The whole request, system prompt included, must fit the budget.
    expect(seen).toBeLessThanOrEqual(20_000);
    // Non-vacuity: the budget must have actually BOUND here, or this test proves nothing about
    // trimming — 200 unbounded chunks would be >200,000 chars.
    expect(seen).toBeGreaterThan(1_000);
  });

  it("reports what the budget dropped instead of silently truncating", async () => {
    const db = withChunksDb();
    for (let i = 0; i < 50; i++) {
      db.prepare(
        "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, 'v1', ?, '0', '[]', ?, ?, 1, 0, ?)",
      ).run(`c${i}`, `N${i}.md`, "y".repeat(1000), `h${i}`, i);
    }
    const res = await runSynthesis({
      db,
      roles: rolesReturning('{"patterns":[],"clusters":[]}'),
      now: () => 0,
      maxPromptChars: 12_000,
    });
    expect(res.ok).toBe(true);
    const vaults = res.detail?.vaults as Array<Record<string, unknown>> | undefined;
    expect(vaults).toBeDefined();
    const v = (vaults as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    // A pass that quietly used 9 of 50 chunks is indistinguishable from one that used all 50.
    expect(v.chunks_used).toBeLessThan(50);
    expect(v.chunks_dropped).toBe(50 - (v.chunks_used as number));
  });

  it("pulls recent chunks, calls the synthesize role, and stores the record", async () => {
    const db = withChunksDb();
    db.prepare(
      "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES ('a', 'v1', 'A.md', '0', '[]', 'recent note', 'h', 1, 0, 1)",
    ).run();
    const synth =
      '{"patterns":[{"title":"t","summary":"s","evidence_paths":["A.md"],"contradiction_ids":[]}],"clusters":[{"label":"l","summary":"s","chunk_paths":["A.md"]}]}';
    const res = await runSynthesis({
      db,
      roles: rolesReturning(synth),
      now: () => Date.UTC(2026, 5, 1),
    });
    expect(res.ok).toBe(true);
    const row = db
      .prepare(
        "SELECT pattern_count, cluster_count, judge_model FROM syntheses WHERE vault_id = 'v1'",
      )
      .get() as {
      pattern_count: number;
      cluster_count: number;
      judge_model: string;
    };
    expect(row.pattern_count).toBe(1);
    expect(row.cluster_count).toBe(1);
    expect(row.judge_model).toBe("opus");
  });

  it("skips cleanly when there are no chunks", async () => {
    const db = withChunksDb();
    const res = await runSynthesis({ db, roles: rolesReturning("{}"), now: () => 1 });
    expect(res.ok).toBe(true);
    expect(res.detail?.skipped).toBe("no chunks");
  });

  it("writes one synthesis per vault, each blending only its own vault's chunks", async () => {
    const db = withChunksDb();
    db.prepare(
      "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES ('a', 'v1', 'A.md', '0', '[]', 'note one', 'h1', 1, 0, 1)",
    ).run();
    db.prepare(
      "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES ('b', 'v2', 'B.md', '0', '[]', 'note two', 'h2', 1, 0, 1)",
    ).run();
    const synth =
      '{"patterns":[{"title":"t","summary":"s","evidence_paths":["A.md"],"contradiction_ids":[]}],"clusters":[{"label":"l","summary":"s","chunk_paths":["A.md"]}]}';
    const res = await runSynthesis({
      db,
      roles: rolesReturning(synth),
      now: () => Date.UTC(2026, 5, 1),
    });
    expect(res.ok).toBe(true);
    const vaults = (
      db.prepare("SELECT vault_id FROM syntheses ORDER BY vault_id").all() as { vault_id: string }[]
    ).map((r) => r.vault_id);
    expect(vaults).toEqual(["v1", "v2"]);
  });
});

describe("synthesis — egress.excludePaths (THE-934)", () => {
  function seedChunk(db: Database, id: string, path: string, content: string, ts: number): void {
    db.prepare(
      "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, 'v1', ?, '0', '[]', ?, ?, 1, 0, ?)",
    ).run(id, path, content, `h-${id}`, ts);
  }

  it("drops an excluded chunk before it is a synthesis candidate — no excluded text in the request", async () => {
    const db = withChunksDb();
    seedChunk(db, "a", "Public/A.md", "public note", 1);
    seedChunk(db, "p", "Private/P.md", "private secret note", 2);
    let seenMessage = "";
    const roles: GatewayRoles = {
      extract: async () => ({ text: "", model: "m" }),
      judge: async () => ({ text: "", model: "m" }),
      synthesize: async (req) => {
        seenMessage = req.messages.map((m) => m.content).join("");
        return { text: '{"patterns":[],"clusters":[]}', model: "m" };
      },
    };
    const res = await runSynthesis({
      db,
      roles,
      now: () => 1,
      excludeFilter: compileEgressFilter(["Private/**"]),
    });
    expect(res.ok).toBe(true);
    expect(seenMessage).toContain("public note");
    expect(seenMessage).not.toContain("private secret note");
    expect(seenMessage).not.toContain("Private/P.md");
  });

  it("skips a vault entirely when every chunk is excluded — zero gateway calls for it", async () => {
    const db = withChunksDb();
    seedChunk(db, "p", "Private/P.md", "private secret note", 1);
    let calls = 0;
    const roles: GatewayRoles = {
      extract: async () => ({ text: "", model: "m" }),
      judge: async () => ({ text: "", model: "m" }),
      synthesize: async () => {
        calls += 1;
        return { text: '{"patterns":[],"clusters":[]}', model: "m" };
      },
    };
    const res = await runSynthesis({
      db,
      roles,
      now: () => 1,
      excludeFilter: compileEgressFilter(["Private/**"]),
    });
    expect(calls).toBe(0);
    expect(res.detail?.skipped).toBe("no chunks");
  });

  it("sourcePaths on the request is exactly what landed in the message", async () => {
    const db = withChunksDb();
    seedChunk(db, "a", "Public/A.md", "public note", 1);
    seedChunk(db, "p", "Private/P.md", "private secret note", 2);
    let seenSourcePaths: string[] = [];
    const roles: GatewayRoles = {
      extract: async () => ({ text: "", model: "m" }),
      judge: async () => ({ text: "", model: "m" }),
      synthesize: async (req) => {
        seenSourcePaths = req.sourcePaths ?? [];
        return { text: '{"patterns":[],"clusters":[]}', model: "m" };
      },
    };
    await runSynthesis({
      db,
      roles,
      now: () => 1,
      excludeFilter: compileEgressFilter(["Private/**"]),
    });
    expect(seenSourcePaths).toEqual(["Public/A.md"]);
  });

  it("planSynthesis: dry-run candidate counts reflect the exclusion, with ZERO gateway calls", async () => {
    const db = withChunksDb();
    seedChunk(db, "a", "Public/A.md", "public note", 1);
    seedChunk(db, "p", "Private/P.md", "private secret note", 2);
    let calls = 0;
    const countingRoles: GatewayRoles = {
      extract: async () => ({ text: "", model: "m" }),
      judge: async () => ({ text: "", model: "m" }),
      synthesize: async () => {
        calls += 1;
        return { text: '{"patterns":[],"clusters":[]}', model: "m" };
      },
    };
    const plans = planSynthesis({
      db,
      roles: countingRoles,
      now: () => 1,
      excludeFilter: compileEgressFilter(["Private/**"]),
    });
    expect(calls).toBe(0); // planSynthesis never touches ctx.roles
    expect(plans).toEqual([
      { vault_id: "v1", chunks_candidate: 1, contradictions_candidate: 0, estimated_calls: 1 },
    ]);
  });

  it("planSynthesis matches runSynthesis' own candidate count (no double-filtering drift)", async () => {
    const db = withChunksDb();
    for (let i = 0; i < 5; i++) seedChunk(db, `c${i}`, `N${i}.md`, `note ${i}`, i);
    seedChunk(db, "p", "Private/P.md", "excluded", 100);
    const filter = compileEgressFilter(["Private/**"]);
    const plans = planSynthesis({ db, roles: null, now: () => 1, excludeFilter: filter });
    expect(plans[0]?.chunks_candidate).toBe(5);

    let chunksUsed = 0;
    const roles: GatewayRoles = {
      extract: async () => ({ text: "", model: "m" }),
      judge: async () => ({ text: "", model: "m" }),
      synthesize: async () => ({ text: '{"patterns":[],"clusters":[]}', model: "m" }),
    };
    // Re-run for real (unbounded budget) and confirm the SAME count actually got used.
    const res = await runSynthesis({ db, roles, now: () => 1, excludeFilter: filter });
    expect(res.ok).toBe(true);
    const detail = res.detail as { vaults: Array<{ chunks_used: number }> };
    chunksUsed = detail.vaults[0]?.chunks_used ?? 0;
    expect(chunksUsed).toBe(5);
  });

  it("THE-934 fix round 3 (G): a vault whose ONLY recent chunk is excluded reports estimated_calls: 0, matching runSynthesis' own zero-call skip", async () => {
    const db = withChunksDb();
    seedChunk(db, "p", "Private/P.md", "private secret note", 1); // the vault's ONLY chunk
    const filter = compileEgressFilter(["Private/**"]);
    const plans = planSynthesis({ db, roles: null, now: () => 1, excludeFilter: filter });
    expect(plans).toEqual([
      { vault_id: "v1", chunks_candidate: 0, contradictions_candidate: 0, estimated_calls: 0 },
    ]);

    let calls = 0;
    const roles: GatewayRoles = {
      extract: async () => ({ text: "", model: "m" }),
      judge: async () => ({ text: "", model: "m" }),
      synthesize: async () => {
        calls += 1;
        return { text: '{"patterns":[],"clusters":[]}', model: "m" };
      },
    };
    await runSynthesis({ db, roles, now: () => 1, excludeFilter: filter });
    expect(calls).toBe(0); // the plan's estimate now agrees with the real run
  });
});
