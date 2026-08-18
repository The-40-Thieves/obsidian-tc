// THE-636 — export/import of the derived plane as a vendor-neutral bundle. Full migration chain
// (experientialMigrations) is used rather than a hand-picked prefix (contrast forget.test.ts's
// edb0()) because this module reads/writes all 9 experiential tables across their FULL current
// shape, including columns added by migrations well after each table's creation.
//
// Post-review revision: an adversarial review of PR #808 confirmed two blockers, reproduced
// twice each. This file's forget_log-reconciliation and vault-identity describe blocks were
// rewritten to pin the FIXED behavior — see context-bundle.ts's module header for the full
// reasoning behind both fixes.
import { describe, expect, it } from "vitest";
import { experientialMigrations } from "../src/cli/shared";
import { runMigrations } from "../src/db/migrate";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import {
  exportContextBundle,
  importContextBundle,
  remapBundleVault,
  validateContextBundle,
} from "../src/experiential/context-bundle";
import { BUNDLE_FORMAT_VERSION } from "../src/experiential/context-bundle-schema";
import { verifyForgetLog } from "../src/experiential/forget";
import { openMemoryDb } from "./helpers";

const NOW = 1_700_000_000_000;

function edb(): Database {
  const db = openMemoryDb();
  runMigrations(db, experientialMigrations);
  return db;
}

function cacheDb(): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  return db;
}

function seedEpisode(
  db: Database,
  id: string,
  opts: { vaultId?: string; blocked?: 0 | 1; ts?: number } = {},
): void {
  db.prepare(
    `INSERT INTO agent_episodes (id, ts, vault_id, caller, channel, episode_type, tool, status, eligibility, blocked, valid_from)
     VALUES (?, ?, ?, 'alice', 'dispatch', 'tool_call', 'read_note', 'ok', 'eligible', ?, ?)`,
  ).run(id, opts.ts ?? NOW, opts.vaultId ?? "main", opts.blocked ?? 0, opts.ts ?? NOW);
}

/** Ground-truth fixture for BLOCKER 2b: a `chunks` row the target's cache.db actually indexed. */
function seedChunk(cache: Database, id: string, vaultId = "main", path = "notes/a.md"): void {
  cache
    .prepare(
      "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, 0, '[]', 'c', ?, 10, ?, ?)",
    )
    .run(id, vaultId, path, id, NOW, NOW);
}

const ZERO_STATS = {
  imported: 0,
  skipped_duplicate: 0,
  skipped_forgotten: 0,
  skipped_unmatched: 0,
};

describe("exportContextBundle", () => {
  it("produces all 9 table names with a versioned envelope (acceptance 1)", () => {
    const db = edb();
    seedEpisode(db, "e1");
    db.prepare(
      "INSERT INTO preference_profile (vault_id, key, value, weight, version, updated_at, provenance) VALUES ('main','tone','terse',2.0,1,?,'note')",
    ).run(NOW);
    const bundle = exportContextBundle(db, { nowMs: NOW, serverVersion: "1.2.3" });
    expect(bundle.format_version).toBe(BUNDLE_FORMAT_VERSION);
    expect(bundle.exported_at).toBe(NOW);
    expect(bundle.server_version).toBe("1.2.3");
    expect(bundle.vault).toBe("*");
    expect(bundle.score_version).toBeGreaterThan(0);
    expect(Object.keys(bundle.tables).sort()).toEqual(
      [
        "agent_episodes",
        "chunk_retrievals",
        "forget_log",
        "gap_reports",
        "goals",
        "note_quality",
        "preference_deltas",
        "preference_profile",
        "vault_object_state",
      ].sort(),
    );
    expect(bundle.tables.agent_episodes).toHaveLength(1);
    expect(bundle.tables.preference_profile).toHaveLength(1);
  });

  it("excludes a tombstoned episode from agent_episodes, default, no escape hatch (acceptance 3)", () => {
    const db = edb();
    seedEpisode(db, "kept");
    seedEpisode(db, "gone", { blocked: 1 });
    const bundle = exportContextBundle(db, { nowMs: NOW, serverVersion: "1.0.0" });
    const ids = bundle.tables.agent_episodes.map((r) => r.id);
    expect(ids).toEqual(["kept"]);
  });

  it("--vault narrows the 6 SQL-filterable tables; chunk_retrievals/vault_object_state/forget_log stay full", () => {
    const db = edb();
    seedEpisode(db, "e-main", { vaultId: "main" });
    seedEpisode(db, "e-other", { vaultId: "other" });
    db.prepare(
      "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, surface_type, query_text, rank_in_results) VALUES ('r1','c1',?,'s','q',1)",
    ).run(NOW);
    db.prepare(
      "INSERT INTO vault_object_state (object_id, frequency, last_accessed) VALUES ('c1', 1, ?)",
    ).run(NOW);
    db.exec(
      "INSERT INTO forget_log (ts, kind, target, mode, details, prev_hash, hash) VALUES (1,'note','other.md','tombstone','{}','0'||'0'||'0','x')",
    );
    const bundle = exportContextBundle(db, { nowMs: NOW, serverVersion: "1.0.0", vaultId: "main" });
    expect(bundle.vault).toBe("main");
    expect(bundle.tables.agent_episodes.map((r) => r.id)).toEqual(["e-main"]);
    // globally-scoped tables ignore --vault entirely
    expect(bundle.tables.chunk_retrievals).toHaveLength(1);
    expect(bundle.tables.vault_object_state).toHaveLength(1);
    expect(bundle.tables.forget_log).toHaveLength(1);
  });
});

describe("validateContextBundle", () => {
  it("rejects a format_version mismatch as its own error, not a generic shape error", () => {
    const db = edb();
    const bundle = exportContextBundle(db, { nowMs: NOW, serverVersion: "1.0.0" });
    const bad = { ...bundle, format_version: 999 };
    const r = validateContextBundle(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/format_version mismatch/);
  });

  it("rejects a malformed row with a schema error naming the table/field", () => {
    const db = edb();
    const bundle = exportContextBundle(db, { nowMs: NOW, serverVersion: "1.0.0" });
    const bad = {
      ...bundle,
      tables: { ...bundle.tables, goals: [{ id: "g1" /* missing required fields */ }] },
    };
    const r = validateContextBundle(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/goals/);
  });

  it("round-trips a real export unchanged", () => {
    const db = edb();
    seedEpisode(db, "e1");
    const bundle = exportContextBundle(db, { nowMs: NOW, serverVersion: "1.0.0" });
    const r = validateContextBundle(JSON.parse(JSON.stringify(bundle)));
    expect(r.ok).toBe(true);
  });
});

describe("importContextBundle — idempotency", () => {
  it("re-importing the same bundle writes nothing new anywhere (natural-key dedup)", () => {
    const src = edb();
    seedEpisode(src, "e1");
    src
      .prepare(
        "INSERT INTO preference_profile (vault_id, key, value, weight, version, updated_at, provenance) VALUES ('main','tone','terse',2.0,1,?,NULL)",
      )
      .run(NOW);
    src
      .prepare(
        "INSERT INTO preference_deltas (ts, key, op, value, evidence, version, vault_id) VALUES (?,'tone','add','terse','ev',1,'main')",
      )
      .run(NOW);
    src
      .prepare(
        "INSERT INTO gap_reports (vault_id, computed_at, threshold, min_results, total, gaps, gap_rate, items) VALUES ('main',?,0.5,3,10,2,0.2,'[]')",
      )
      .run(NOW);
    const bundle = exportContextBundle(src, { nowMs: NOW, serverVersion: "1.0.0" });

    const target = edb();
    const cache = cacheDb();
    const first = importContextBundle(target, cache, bundle);
    expect(first.tables.agent_episodes.imported).toBe(1);
    expect(first.tables.preference_profile.imported).toBe(1);
    expect(first.tables.preference_deltas.imported).toBe(1);
    expect(first.tables.gap_reports.imported).toBe(1);

    const second = importContextBundle(target, cache, bundle);
    expect(second.tables.agent_episodes).toEqual({ ...ZERO_STATS, skipped_duplicate: 1 });
    expect(second.tables.preference_profile.skipped_duplicate).toBe(1);
    expect(second.tables.preference_deltas.skipped_duplicate).toBe(1);
    expect(second.tables.gap_reports.skipped_duplicate).toBe(1);

    const count = (t: string) =>
      (target.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    expect(count("agent_episodes")).toBe(1);
    expect(count("preference_profile")).toBe(1);
    expect(count("preference_deltas")).toBe(1);
    expect(count("gap_reports")).toBe(1);
  });
});

describe("importContextBundle — dry-run (acceptance 4)", () => {
  it("reports counts and writes nothing on a fresh install", () => {
    const src = edb();
    seedEpisode(src, "e1");
    const bundle = exportContextBundle(src, { nowMs: NOW, serverVersion: "1.0.0" });

    const target = edb();
    const cache = cacheDb();
    const before: Record<string, number> = {};
    const tables = Object.keys(bundle.tables);
    for (const t of tables)
      before[t] = (target.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;

    const result = importContextBundle(target, cache, bundle, { dryRun: true });
    expect(result.dry_run).toBe(true);
    expect(result.tables.agent_episodes.imported).toBe(1);

    for (const t of tables) {
      const after = (target.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
      expect(after).toBe(before[t]);
    }
  });
});

describe("importContextBundle — malformed row aborts the whole import (acceptance 8)", () => {
  it("validateContextBundle rejects before any table is touched, even with unrelated valid rows present", () => {
    const src = edb();
    seedEpisode(src, "e1");
    src
      .prepare(
        "INSERT INTO preference_profile (vault_id, key, value, weight, version, updated_at, provenance) VALUES ('main','tone','terse',2.0,1,?,NULL)",
      )
      .run(NOW);
    const bundle = exportContextBundle(src, { nowMs: NOW, serverVersion: "1.0.0" });
    const raw = JSON.parse(JSON.stringify(bundle));
    // corrupt one row in a table OTHER than the two valid ones above (agent_episodes,
    // preference_profile) — proves the gate is whole-bundle, not per-table.
    raw.tables.goals = [{ id: "g1", vault_id: "main" /* missing text/status/source/created_at */ }];

    const validated = validateContextBundle(raw);
    expect(validated.ok).toBe(false);
    if (!validated.ok) expect(validated.error).toMatch(/goals/);

    // cli/commands/context-import.ts (run_context_import) calls validateContextBundle and exits
    // WITHOUT ever calling importContextBundle when it fails — that ordering is what makes "no
    // rows written to any table" true, and is exercised end-to-end (real file, real subprocess,
    // exit code) in cli-smoke.test.ts. Pinned here: a target that was never touched stays empty.
    const target = edb();
    for (const t of Object.keys(bundle.tables)) {
      expect((target.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n).toBe(0);
    }
  });
});

describe("forget_log reconciliation (THE-239/THE-605/THE-609 — forget wins over import)", () => {
  // BLOCKER 1 (review): the original check gated on `forget_log.ts >= bundle.exported_at`, which
  // FAILED OPEN on exactly the primary migration case — a bundle exported NOW carrying content a
  // target forgot LONG AGO. Both directions are pinned below: the adversarial one the review
  // reproduced, and the one the original (over-narrow) test already covered.

  it("ADVERSARIAL: target forgot BEFORE the bundle's exported_at — still never resurrected", () => {
    const src = edb();
    seedEpisode(src, "e1"); // unblocked at the SOURCE — it never forgot e1
    // Bundle exported well AFTER the target's forget below.
    const exportedAt = NOW + 10_000;
    const bundle = exportContextBundle(src, { nowMs: exportedAt, serverVersion: "1.0.0" });
    expect(bundle.tables.agent_episodes.map((r) => r.id)).toEqual(["e1"]);

    const target = edb();
    const cache = cacheDb();
    // Target forgot e1 LONG BEFORE the export (ts < bundle.exported_at) — the exact case the
    // `ts >=` gate could not see, because a forget in the past always has ts < a later export.
    target
      .prepare(
        "INSERT INTO forget_log (ts, kind, target, mode, details, prev_hash, hash) VALUES (?,'episode','e1','tombstone','{}',?,?)",
      )
      .run(NOW - 10_000, "0".repeat(64), "a".repeat(64));

    const result = importContextBundle(target, cache, bundle);
    expect(result.tables.agent_episodes).toEqual({ ...ZERO_STATS, skipped_forgotten: 1 });
    const row = target.prepare("SELECT id FROM agent_episodes WHERE id = 'e1'").get();
    expect(row).toBeUndefined(); // never resurrected
  });

  it("target forgot AFTER the bundle's exported_at — still never resurrected (previously covered)", () => {
    const src = edb();
    seedEpisode(src, "e1"); // unblocked at export time
    const bundle = exportContextBundle(src, { nowMs: NOW, serverVersion: "1.0.0" });
    expect(bundle.tables.agent_episodes.map((r) => r.id)).toEqual(["e1"]);

    const target = edb();
    const cache = cacheDb();
    // Target forgot e1 AFTER the bundle's exported_at — simulating the receiving install diverging.
    target
      .prepare(
        "INSERT INTO forget_log (ts, kind, target, mode, details, prev_hash, hash) VALUES (?,'episode','e1','tombstone','{}',?,?)",
      )
      .run(NOW + 1000, "0".repeat(64), "a".repeat(64));

    const result = importContextBundle(target, cache, bundle);
    expect(result.tables.agent_episodes).toEqual({ ...ZERO_STATS, skipped_forgotten: 1 });
    const row = target.prepare("SELECT id FROM agent_episodes WHERE id = 'e1'").get();
    expect(row).toBeUndefined(); // never resurrected
  });

  it("direction (b): an imported forget_log entry blocks matching content already in the target", () => {
    const src = edb();
    // Source's OWN forget_log has an episode-forget entry for e2 (e2 itself is therefore NOT in
    // the source's own agent_episodes export — it was excluded as blocked=1 there).
    seedEpisode(src, "e2", { blocked: 1 });
    src
      .prepare(
        "INSERT INTO forget_log (ts, kind, target, mode, details, prev_hash, hash) VALUES (?,'episode','e2','tombstone','{}',?,?)",
      )
      .run(NOW - 1000, "0".repeat(64), "b".repeat(64));
    const bundle = exportContextBundle(src, { nowMs: NOW, serverVersion: "1.0.0" });
    expect(bundle.tables.agent_episodes.map((r) => r.id)).toEqual([]); // e2 excluded from the export
    expect(bundle.tables.forget_log.some((r) => r.target === "e2" && r.kind === "episode")).toBe(
      true,
    );

    const target = edb();
    const cache = cacheDb();
    // Target has its OWN e2, unblocked — never touched by any forget on the target itself.
    seedEpisode(target, "e2");
    const before = target.prepare("SELECT blocked FROM agent_episodes WHERE id = 'e2'").get() as {
      blocked: number;
    };
    expect(before.blocked).toBe(0);

    importContextBundle(target, cache, bundle);

    const after = target.prepare("SELECT blocked FROM agent_episodes WHERE id = 'e2'").get() as {
      blocked: number;
    };
    expect(after.blocked).toBe(1); // the imported forget_log entry applied to pre-existing content
    expect(verifyForgetLog(target).ok).toBe(true);
  });

  it("forget_log import reconstructs a chain that verifies on a fresh install (acceptance 5)", () => {
    const src = edb();
    seedEpisode(src, "e1");
    src
      .prepare(
        "INSERT INTO forget_log (ts, kind, target, mode, details, prev_hash, hash) VALUES (?,'note','a.md','tombstone','{\"chunks\":0}',?,?)",
      )
      .run(NOW - 5000, "0".repeat(64), "c".repeat(64));
    const bundle = exportContextBundle(src, { nowMs: NOW, serverVersion: "1.0.0" });

    const target = edb();
    const cache = cacheDb();
    const result = importContextBundle(target, cache, bundle);
    expect(result.tables.forget_log.imported).toBe(1);
    expect(verifyForgetLog(target)).toEqual({ ok: true, entries: 1 });
  });

  it("(item c) an imported forget_log entry is marked in `details` — distinguishable from a native one", () => {
    const src = edb();
    src
      .prepare(
        "INSERT INTO forget_log (ts, kind, target, mode, details, prev_hash, hash) VALUES (?,'note','a.md','tombstone','{\"chunks\":2}',?,?)",
      )
      .run(NOW - 5000, "0".repeat(64), "d".repeat(64));
    const bundle = exportContextBundle(src, { nowMs: NOW, serverVersion: "9.9.9" });

    const target = edb();
    const cache = cacheDb();
    // A NATIVE entry, appended directly (not via import) — the baseline "no flag" shape.
    target
      .prepare(
        "INSERT INTO forget_log (ts, kind, target, mode, details, prev_hash, hash) VALUES (?,'note','native.md','tombstone','{}',?,?)",
      )
      .run(NOW - 2000, "0".repeat(64), "e".repeat(64));

    importContextBundle(target, cache, bundle);

    const rows = target
      .prepare("SELECT target, details FROM forget_log ORDER BY seq ASC")
      .all() as Array<{ target: string; details: string }>;
    const native = rows.find((r) => r.target === "native.md");
    const imported = rows.find((r) => r.target === "a.md");
    expect(native).toBeDefined();
    expect(imported).toBeDefined();
    expect(JSON.parse(native?.details ?? "{}").imported).toBeUndefined();
    const importedDetails = JSON.parse(imported?.details ?? "{}");
    expect(importedDetails.imported).toBe(true);
    expect(importedDetails.imported_from).toBe("9.9.9");
    expect(importedDetails.chunks).toBe(2); // original details survive alongside the flag
  });
});

describe("remapBundleVault (THE-636 review fix, BLOCKER 2a — cross-install vault identity)", () => {
  it("no-op when targetVault is omitted — rows keep the bundle's verbatim vault_id", () => {
    const src = edb();
    src
      .prepare(
        "INSERT INTO preference_profile (vault_id, key, value, weight, version, updated_at, provenance) VALUES ('main','tone','terse',2.0,1,?,NULL)",
      )
      .run(NOW);
    const bundle = exportContextBundle(src, { nowMs: NOW, serverVersion: "1.0.0" });
    const r = remapBundleVault(bundle, undefined);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bundle).toBe(bundle); // literally unchanged, not just equal
  });

  it("remaps every vault-scoped row's vault_id to the operator-chosen target", () => {
    const src = edb();
    src
      .prepare(
        "INSERT INTO preference_profile (vault_id, key, value, weight, version, updated_at, provenance) VALUES ('main','tone','terse',2.0,1,?,NULL)",
      )
      .run(NOW);
    src
      .prepare(
        "INSERT INTO goals (id, vault_id, text, status, source, created_at) VALUES ('g1','main','ship it','open','stated',?)",
      )
      .run(NOW);
    seedEpisode(src, "e1", { vaultId: "main" });
    const bundle = exportContextBundle(src, { nowMs: NOW, serverVersion: "1.0.0" });

    const r = remapBundleVault(bundle, "imported-main");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bundle.tables.preference_profile[0]?.vault_id).toBe("imported-main");
    expect(r.bundle.tables.goals[0]?.vault_id).toBe("imported-main");
    expect(r.bundle.tables.agent_episodes[0]?.vault_id).toBe("imported-main");
  });

  it("leaves a null agent_episodes.vault_id null (not vault-scoped at capture)", () => {
    const src = edb();
    src
      .prepare(
        `INSERT INTO agent_episodes (id, ts, vault_id, caller, channel, episode_type, tool, status, eligibility, blocked, valid_from)
         VALUES ('e1', ?, NULL, 'alice', 'dispatch', 'tool_call', 'read_note', 'ok', 'eligible', 0, ?)`,
      )
      .run(NOW, NOW);
    const bundle = exportContextBundle(src, { nowMs: NOW, serverVersion: "1.0.0" });
    expect(bundle.tables.agent_episodes[0]?.vault_id).toBeNull();

    const r = remapBundleVault(bundle, "target-vault");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bundle.tables.agent_episodes[0]?.vault_id).toBeNull();
  });

  it("refuses a bundle whose vault-scoped tables name more than one source vault", () => {
    const src = edb();
    src
      .prepare(
        "INSERT INTO preference_profile (vault_id, key, value, weight, version, updated_at, provenance) VALUES ('vault-a','tone','terse',2.0,1,?,NULL)",
      )
      .run(NOW);
    src
      .prepare(
        "INSERT INTO goals (id, vault_id, text, status, source, created_at) VALUES ('g1','vault-b','ship it','open','stated',?)",
      )
      .run(NOW);
    // Deployment-wide export ("*") spanning two vaults — the exact shape a naive single-vault
    // assumption would mishandle.
    const bundle = exportContextBundle(src, { nowMs: NOW, serverVersion: "1.0.0" });
    expect(bundle.vault).toBe("*");

    const r = remapBundleVault(bundle, "target-vault");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/vault-a/);
      expect(r.error).toMatch(/vault-b/);
    }
  });

  it("end to end: --vault-equivalent remap prevents two unrelated 'main' vaults from merging", () => {
    // Install A's "main" vault exports preference_profile.
    const srcA = edb();
    srcA
      .prepare(
        "INSERT INTO preference_profile (vault_id, key, value, weight, version, updated_at, provenance) VALUES ('main','tone','terse',2.0,1,?,NULL)",
      )
      .run(NOW);
    const bundle = exportContextBundle(srcA, { nowMs: NOW, serverVersion: "1.0.0" });

    // Install B (the target) ALSO has an UNRELATED vault called "main", already carrying its own
    // preference row that must survive untouched, plus a distinctly-labelled vault to import into.
    const target = edb();
    const cache = cacheDb();
    target
      .prepare(
        "INSERT INTO preference_profile (vault_id, key, value, weight, version, updated_at, provenance) VALUES ('main','tone','verbose',2.0,1,?,NULL)",
      )
      .run(NOW);

    const remapped = remapBundleVault(bundle, "installA-main");
    expect(remapped.ok).toBe(true);
    if (!remapped.ok) return;
    importContextBundle(target, cache, remapped.bundle);

    const rows = target
      .prepare("SELECT vault_id, value FROM preference_profile ORDER BY vault_id")
      .all() as Array<{ vault_id: string; value: string }>;
    expect(rows).toEqual([
      { vault_id: "installA-main", value: "terse" }, // imported under the REMAPPED id
      { vault_id: "main", value: "verbose" }, // target's own "main" untouched — no merge
    ]);
  });
});

describe("chunk-id ground-truth verification (THE-636 review fix, BLOCKER 2b)", () => {
  it("imports a chunk_retrievals/vault_object_state row only when the target has indexed that chunk id", () => {
    const src = edb();
    src
      .prepare(
        "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, surface_type, query_text, rank_in_results) VALUES ('r-matched','c-matched',?,'s','q',1)",
      )
      .run(NOW);
    src
      .prepare(
        "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, surface_type, query_text, rank_in_results) VALUES ('r-unmatched','c-unmatched',?,'s','q',1)",
      )
      .run(NOW);
    src
      .prepare(
        "INSERT INTO vault_object_state (object_id, frequency, last_accessed) VALUES ('c-matched', 3, ?)",
      )
      .run(NOW);
    src
      .prepare(
        "INSERT INTO vault_object_state (object_id, frequency, last_accessed) VALUES ('c-unmatched', 3, ?)",
      )
      .run(NOW);
    const bundle = exportContextBundle(src, { nowMs: NOW, serverVersion: "1.0.0" });

    const target = edb();
    const cache = cacheDb();
    seedChunk(cache, "c-matched"); // the target HAS indexed this chunk id; "c-unmatched" it has not

    const result = importContextBundle(target, cache, bundle);
    expect(result.tables.chunk_retrievals).toEqual({
      ...ZERO_STATS,
      imported: 1,
      skipped_unmatched: 1,
    });
    expect(result.tables.vault_object_state).toEqual({
      ...ZERO_STATS,
      imported: 1,
      skipped_unmatched: 1,
    });
    const cr = target.prepare("SELECT id FROM chunk_retrievals").all() as Array<{ id: string }>;
    expect(cr.map((r) => r.id)).toEqual(["r-matched"]);
    const vos = target.prepare("SELECT object_id FROM vault_object_state").all() as Array<{
      object_id: string;
    }>;
    expect(vos.map((r) => r.object_id)).toEqual(["c-matched"]);
  });

  it("a never-indexed target (no `chunks` table row / fresh install) skips every row as unmatched, not a crash", () => {
    const src = edb();
    src
      .prepare(
        "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, surface_type, query_text, rank_in_results) VALUES ('r1','c1',?,'s','q',1)",
      )
      .run(NOW);
    const bundle = exportContextBundle(src, { nowMs: NOW, serverVersion: "1.0.0" });

    const target = edb();
    const cache = cacheDb(); // provisioned (chunks table exists), but genuinely empty
    const result = importContextBundle(target, cache, bundle);
    expect(result.tables.chunk_retrievals).toEqual({ ...ZERO_STATS, skipped_unmatched: 1 });
    expect(
      (target.prepare("SELECT COUNT(*) AS n FROM chunk_retrievals").get() as { n: number }).n,
    ).toBe(0);
  });

  it("dry-run reports skipped_unmatched without needing to write", () => {
    const src = edb();
    src
      .prepare(
        "INSERT INTO vault_object_state (object_id, frequency, last_accessed) VALUES ('c1', 1, ?)",
      )
      .run(NOW);
    const bundle = exportContextBundle(src, { nowMs: NOW, serverVersion: "1.0.0" });

    const target = edb();
    const cache = cacheDb();
    const result = importContextBundle(target, cache, bundle, { dryRun: true });
    expect(result.tables.vault_object_state).toEqual({ ...ZERO_STATS, skipped_unmatched: 1 });
  });
});

describe("true round-trip equality (export -> import into a fresh DB -> re-export -> compare)", () => {
  it("re-exporting a freshly-imported bundle reproduces the original, modulo justified diffs", () => {
    const src = edb();
    const srcCache = cacheDb();
    seedEpisode(src, "e1", { vaultId: "main" });
    src
      .prepare(
        "INSERT INTO preference_profile (vault_id, key, value, weight, version, updated_at, provenance) VALUES ('main','tone','terse',2.0,1,?,NULL)",
      )
      .run(NOW);
    src
      .prepare(
        "INSERT INTO goals (id, vault_id, text, status, source, created_at) VALUES ('g1','main','ship it','open','stated',?)",
      )
      .run(NOW);
    seedChunk(srcCache, "c1");
    src
      .prepare(
        "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, surface_type, query_text, rank_in_results) VALUES ('r1','c1',?,'s','q',1)",
      )
      .run(NOW);
    src
      .prepare(
        "INSERT INTO vault_object_state (object_id, frequency, last_accessed) VALUES ('c1', 3, ?)",
      )
      .run(NOW);

    const exported = exportContextBundle(src, { nowMs: NOW, serverVersion: "1.0.0" });

    // Import into a FRESH target whose cache.db already indexed the same chunk id (so the
    // ground-truth check in BLOCKER 2b doesn't itself introduce a diff for this test's purpose —
    // that check's own behavior is pinned separately above).
    const target = edb();
    const targetCache = cacheDb();
    seedChunk(targetCache, "c1");
    const importResult = importContextBundle(target, targetCache, exported);
    expect(importResult.tables.agent_episodes.imported).toBe(1);
    expect(importResult.tables.preference_profile.imported).toBe(1);
    expect(importResult.tables.goals.imported).toBe(1);
    expect(importResult.tables.chunk_retrievals.imported).toBe(1);
    expect(importResult.tables.vault_object_state.imported).toBe(1);

    const reExported = exportContextBundle(target, { nowMs: NOW + 1, serverVersion: "1.0.0" });

    // Justified diffs: exported_at (re-export ran at a different nowMs) and forget_log (empty in
    // this fixture either way, so not exercised here — see the forget_log-specific round-trip
    // pin, "reconstructs a chain that verifies", above). Everything else must match byte-for-byte.
    const { exported_at: _a, ...exportedRest } = exported;
    const { exported_at: _b, ...reExportedRest } = reExported;
    expect(reExportedRest).toEqual(exportedRest);
  });
});
