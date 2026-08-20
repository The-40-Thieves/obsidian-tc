// THE-644 — the citation-evidence half of deterministic preference extraction: fold
// chunk_retrievals' citation_state (THE-717's judge verdict) into preferred.search_mode
// alongside episode task_result, gated behind `experiential.citationPreferences` (default off).
//
// Binding requirements pinned here, mirroring the THE-673 episode-side tests:
//   * off (no cacheDb) is byte-identical to before this ticket — citationEvidence is never reached;
//   * a CONFIRMED verdict strengthens (op=add), a REJECTED one weakens (op=weaken);
//   * candidate/uncertain/NULL verdicts are unmeasured, not negative — no delta;
//   * a non-search-family surface_type never contributes, same restriction as the episode side;
//   * one event_group (one search call) yields exactly ONE delta, not one per returned chunk;
//   * chunk_retrievals has no vault_id — a chunk absent from the TARGET vault's cache.db chunks
//     table is a foreign-vault or deleted chunk and must be dropped, never attributed.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import {
  applyPreferenceDeltas,
  type CitationEvidenceRow,
  extractPreferences,
  groupCitationEvidenceByEventGroup,
  preferenceProfile,
} from "../src/experiential/reflect";
import { openMemoryDb } from "./helpers";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");
const CHAIN = EXPERIENTIAL_MIGRATION_FILES.map((f) => ({ version: versionOf(f), sql: read(f) }));

const NOW = 1_800_000_000_000;
const V1 = "main";
const V2 = "other-vault";

function stores(): { cacheDb: Database; edb: Database } {
  const cacheDb = openMemoryDb();
  provisionCacheDb(cacheDb);
  const edb = openMemoryDb();
  runMigrations(edb, CHAIN);
  return { cacheDb, edb };
}

/** Seed a cache.db chunk under `vaultId`, so citationEvidence's ground-truth join can find it. */
function seedChunk(cacheDb: Database, vaultId: string, chunkId: string, path = "note.md"): void {
  cacheDb
    .prepare(
      "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at, body_sha) VALUES (?, ?, ?, 0, '[]', ?, ?, 10, ?, ?, ?)",
    )
    .run(
      chunkId,
      vaultId,
      path,
      `body of ${chunkId}`,
      `hash-${chunkId}`,
      NOW,
      NOW,
      `sha-${chunkId}`,
    );
}

function seedRetrieval(
  edb: Database,
  over: Partial<{
    id: string;
    chunk_id: string;
    surface_type: string | null;
    event_group: string | null;
    citation_state: string | null;
  }> = {},
): void {
  edb
    .prepare(
      `INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, surface_type, query_text, rank_in_results, event_group, citation_state)
       VALUES (?, ?, ?, ?, 'q', 1, ?, ?)`,
    )
    .run(
      over.id ?? `r-${Math.random()}`,
      over.chunk_id ?? "chk_missing",
      NOW,
      over.surface_type ?? "search_text",
      over.event_group ?? null,
      over.citation_state ?? null,
    );
}

describe("groupCitationEvidenceByEventGroup (THE-644)", () => {
  it("collapses rows sharing one event_group into one window; NULL event_group rows stay singleton", () => {
    const rows: CitationEvidenceRow[] = [
      {
        chunk_id: "c1",
        surface_type: "search_text",
        event_group: "eg1",
        citation_state: "confirmed",
      },
      {
        chunk_id: "c2",
        surface_type: "search_text",
        event_group: "eg1",
        citation_state: "rejected",
      },
      {
        chunk_id: "c3",
        surface_type: "search_vault",
        event_group: "eg2",
        citation_state: "confirmed",
      },
      {
        chunk_id: "c4",
        surface_type: "search_text",
        event_group: null,
        citation_state: "confirmed",
      },
      {
        chunk_id: "c5",
        surface_type: "search_text",
        event_group: null,
        citation_state: "confirmed",
      },
    ];
    const windows = groupCitationEvidenceByEventGroup(rows);
    expect(windows).toHaveLength(4); // eg1 (2 rows), eg2 (1 row), + two NULL singletons
    const bySize = windows.map((w) => w.rows.length).sort();
    expect(bySize).toEqual([1, 1, 1, 2]);
    const merged = windows.find((w) => w.rows.length === 2);
    expect(merged?.rows.map((r) => r.chunk_id).sort()).toEqual(["c1", "c2"]);
  });
});

describe("extractPreferences: citation evidence (THE-644, off by default)", () => {
  it("cacheDb omitted -> citation rows are never read; behaviour is byte-identical to the pre-THE-644 episode-only pass", async () => {
    const { edb } = stores();
    // Evidence exists in chunk_retrievals, but with no cacheDb the caller never looks at it.
    seedRetrieval(edb, {
      chunk_id: "chk1",
      surface_type: "search_text",
      citation_state: "confirmed",
    });
    const r = await extractPreferences(edb, V1, { nowMs: NOW });
    expect(r).toMatchObject({ skipped: true, applied: 0 });
    expect(preferenceProfile(edb, V1).entries).toHaveLength(0);
  });

  it("a CONFIRMED citation on a search-family tool strengthens preferred.search_mode (op=add)", async () => {
    const { cacheDb, edb } = stores();
    seedChunk(cacheDb, V1, "chk1");
    seedRetrieval(edb, {
      chunk_id: "chk1",
      surface_type: "search_vault",
      event_group: "eg1",
      citation_state: "confirmed",
    });
    const r = await extractPreferences(edb, V1, { nowMs: NOW, cacheDb });
    expect(r).toMatchObject({ skipped: false, applied: 1 });
    expect(preferenceProfile(edb, V1).entries).toEqual([
      expect.objectContaining({ key: "preferred.search_mode", value: "search_vault", weight: 1 }),
    ]);
    const ev = edb.prepare("SELECT evidence FROM preference_deltas WHERE vault_id = ?").get(V1) as {
      evidence: string;
    };
    expect(ev.evidence).toBe("citation tool=search_vault confirmed=1 rejected=0");
  });

  it("a REJECTED citation (no confirmed in the window) weakens an existing key", async () => {
    const { cacheDb, edb } = stores();
    seedChunk(cacheDb, V1, "chk1");
    // Establish the key the way a prior +1 extraction would, isolated from this test's own evidence.
    applyPreferenceDeltas(
      edb,
      V1,
      [{ key: "preferred.search_mode", op: "add", value: "search_vault" }],
      NOW,
    );
    const before = preferenceProfile(edb, V1).entries[0]?.weight as number;

    seedRetrieval(edb, {
      chunk_id: "chk1",
      surface_type: "search_vault",
      event_group: "eg1",
      citation_state: "rejected",
    });
    const r = await extractPreferences(edb, V1, { nowMs: NOW + 1, cacheDb });
    expect(r.applied).toBe(1);
    const after = preferenceProfile(edb, V1).entries[0]?.weight as number;
    expect(after).toBeLessThan(before);
  });

  it("candidate/uncertain verdicts reach evidence but are neutral — not skipped, no delta", async () => {
    const { cacheDb, edb } = stores();
    seedChunk(cacheDb, V1, "c1");
    seedChunk(cacheDb, V1, "c2");
    seedRetrieval(edb, {
      chunk_id: "c1",
      surface_type: "search_text",
      citation_state: "candidate",
    });
    seedRetrieval(edb, {
      chunk_id: "c2",
      surface_type: "search_text",
      citation_state: "uncertain",
    });
    const r = await extractPreferences(edb, V1, { nowMs: NOW, cacheDb });
    // NOT skipped: evidence WAS found (candidate/uncertain rows reach the window pass, since
    // citationEvidence only excludes citation_state IS NULL) — it is just neutral, the same
    // "found evidence but derived no delta" distinction the episode side makes for a
    // task_result = 0 window.
    expect(r).toMatchObject({ skipped: false, applied: 0 });
    expect(preferenceProfile(edb, V1).entries).toHaveLength(0);
  });

  it("citation_state IS NULL rows never reach evidence at all — excluded at the query, not merely neutral", async () => {
    const { cacheDb, edb } = stores();
    seedChunk(cacheDb, V1, "c1");
    // Establish the key first, so a NULL row wrongly treated as a negative verdict would WEAKEN
    // it — a stronger discriminator than "no delta" alone, which candidate/uncertain also produce.
    applyPreferenceDeltas(
      edb,
      V1,
      [{ key: "preferred.search_mode", op: "add", value: "search_text" }],
      NOW,
    );
    const before = preferenceProfile(edb, V1).entries[0]?.weight as number;

    seedRetrieval(edb, { chunk_id: "c1", surface_type: "search_text", citation_state: null });
    const r = await extractPreferences(edb, V1, { nowMs: NOW + 1, cacheDb });
    expect(r).toMatchObject({ skipped: true, applied: 0 }); // no OTHER evidence reached the pass
    expect(preferenceProfile(edb, V1).entries[0]?.weight).toBe(before); // unchanged, not weakened
  });

  it("a non-search-family surface_type never contributes, even with a confirmed citation", async () => {
    const { cacheDb, edb } = stores();
    seedChunk(cacheDb, V1, "c1");
    seedRetrieval(edb, {
      chunk_id: "c1",
      surface_type: "knowledge_search",
      citation_state: "confirmed",
    });
    const r = await extractPreferences(edb, V1, { nowMs: NOW, cacheDb });
    expect(r).toMatchObject({ skipped: false, applied: 0 });
    expect(preferenceProfile(edb, V1).entries).toHaveLength(0);
  });

  it("one event_group (one search call) returning multiple chunks yields exactly ONE delta", async () => {
    const { cacheDb, edb } = stores();
    seedChunk(cacheDb, V1, "c1");
    seedChunk(cacheDb, V1, "c2");
    seedChunk(cacheDb, V1, "c3");
    // Same call (eg1): two confirmed, one rejected. If a delta were proposed per row, this would
    // apply 3 deltas instead of 1 — the exact length bias the episode-side windowing also removes.
    seedRetrieval(edb, {
      chunk_id: "c1",
      surface_type: "search_text",
      event_group: "eg1",
      citation_state: "confirmed",
    });
    seedRetrieval(edb, {
      chunk_id: "c2",
      surface_type: "search_text",
      event_group: "eg1",
      citation_state: "confirmed",
    });
    seedRetrieval(edb, {
      chunk_id: "c3",
      surface_type: "search_text",
      event_group: "eg1",
      citation_state: "rejected",
    });
    const r = await extractPreferences(edb, V1, { nowMs: NOW, cacheDb });
    expect(r.applied).toBe(1);
    const ev = edb.prepare("SELECT evidence FROM preference_deltas WHERE vault_id = ?").get(V1) as {
      evidence: string;
    };
    expect(ev.evidence).toBe("citation tool=search_text confirmed=2 rejected=1");
  });

  it("a chunk absent from THIS vault's cache.db chunks table is dropped, never attributed (foreign vault)", async () => {
    const { cacheDb, edb } = stores();
    // The chunk exists, but under a DIFFERENT vault than the one extractPreferences is scoped to.
    seedChunk(cacheDb, V2, "chk-foreign");
    seedRetrieval(edb, {
      chunk_id: "chk-foreign",
      surface_type: "search_text",
      citation_state: "confirmed",
    });
    const r = await extractPreferences(edb, V1, { nowMs: NOW, cacheDb });
    expect(r).toMatchObject({ skipped: true, applied: 0 });
    expect(preferenceProfile(edb, V1).entries).toHaveLength(0);
    // The SAME evidence, scoped to its actual vault, DOES apply — proving the exclusion above was
    // the vault join, not something wrong with the fixture.
    const r2 = await extractPreferences(edb, V2, { nowMs: NOW, cacheDb });
    expect(r2.applied).toBe(1);
  });

  it("determinism: the same seed applied twice in fresh stores produces byte-identical deltas", async () => {
    const build = async () => {
      const { cacheDb, edb } = stores();
      seedChunk(cacheDb, V1, "chk1");
      seedRetrieval(edb, {
        chunk_id: "chk1",
        surface_type: "search_regex",
        event_group: "eg1",
        citation_state: "confirmed",
      });
      await extractPreferences(edb, V1, { nowMs: NOW, cacheDb });
      return edb
        .prepare("SELECT key, op, value, evidence FROM preference_deltas WHERE vault_id = ?")
        .all(V1);
    };
    expect(await build()).toEqual(await build());
  });
});
