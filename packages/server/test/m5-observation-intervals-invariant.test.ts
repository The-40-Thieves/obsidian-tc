// THE-1130 adversarial-review verification — the ordinal-correlation invariant every read path
// (get_entity, query_entity_graph, materialize.ts's rendering) depends on: `parseObservations`'s
// Nth text line and `memory_observation_intervals`' Nth row (per entity_id, ordered by id) must
// always describe the SAME observation. Two classes of adversarial probe live here:
//
//  1. A caller-supplied observation containing an embedded `\n`, or one that is blank after
//     trimming, used to break that invariant SILENTLY: `add_observation`/`create_entity` accepted
//     it, `parseObservations`/`serializeObservations` re-splitting the stored blob on every `\n`
//     produced a DIFFERENT line count than the ONE interval row the write path inserted for it.
//     Fixed by rejecting both cases at the schema boundary (memory/entities.ts's
//     `normalizeObservationText`, shared by create_entity's and add_observation's input schemas) —
//     verified here by asserting the REJECTION, not by asserting a workaround split/drop.
//  2. The migration backfill used SQLite's `trim()` (ASCII space only) where every read path
//     actually uses JS `.trim()` (also strips tab/CR) via `parseObservations` — a tab/CR-bearing
//     fixture parsed to a different line count under each. Fixed by moving the backfill to a JS
//     `postApply` step (db/backfill-observation-intervals.ts) that reuses `parseObservations`
//     itself, so it can never disagree with what every other read path computes.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { backfillObservationIntervalsJs } from "../src/db/backfill-observation-intervals";
import { runMigrations } from "../src/db/migrate";
import { CACHE_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import { parseObservations } from "../src/memory/entities";
import { applyImport } from "../src/memory-import/apply";
import { parseBasicMemoryFile } from "../src/memory-import/basic-memory";
import { parseClaudeCodeMemoryFile } from "../src/memory-import/claude-code-memory";
import { openMemoryDb } from "./helpers";
import { makeM5Vault } from "./m5-helpers";
import { makeMemoryImportHarness } from "./memory-import-helpers";

function counts(v: ReturnType<typeof makeM5Vault>, entityId: string): [number, number] {
  const row = v.db
    .prepare("SELECT observations FROM memory_entities WHERE id = ?")
    .get(entityId) as { observations: string };
  const interval = v.db
    .prepare("SELECT count(*) AS n FROM memory_observation_intervals WHERE entity_id = ?")
    .get(entityId) as { n: number };
  return [parseObservations(row.observations).length, interval.n];
}

describe("THE-1130 ordinal-correlation adversarial verification", () => {
  it("create_entity REJECTS a multiline observation instead of silently splitting it into two parsed lines behind one interval row", async () => {
    const v = makeM5Vault();
    try {
      const created = await v.call(
        "create_entity",
        {
          vault: "test",
          type: "probe",
          name: "create-multiline",
          observations: ["first\nsecond"],
          materialize: false,
        },
        { now: () => 100 },
      );
      expect(created.ok).toBe(false);
      if (!created.ok) expect(created.error.code).toBe("validation_error");
      // Nothing was ever written — no row exists to have drifted.
      expect(v.db.prepare("SELECT count(*) AS n FROM memory_entities").get()).toEqual({ n: 0 });
    } finally {
      v.cleanup();
    }
  });

  it("create_entity REJECTS a whitespace-only observation instead of silently accepting it and dropping the interval row", async () => {
    const v = makeM5Vault();
    try {
      const created = await v.call("create_entity", {
        vault: "test",
        type: "probe",
        name: "create-blank",
        observations: ["  \t  "],
      });
      expect(created.ok).toBe(false);
      if (!created.ok) expect(created.error.code).toBe("validation_error");
    } finally {
      v.cleanup();
    }
  });

  it("add_observation REJECTS a multiline observation instead of silently splitting it into two parsed lines behind one interval row", async () => {
    const v = makeM5Vault();
    try {
      const created = await v.call("create_entity", {
        vault: "test",
        type: "probe",
        name: "append-multiline",
        materialize: false,
      });
      if (!created.ok) throw new Error("create failed");
      const id = (created.data as { entity_id: string }).entity_id;
      const multiline = await v.call("add_observation", {
        vault: "test",
        entity_id: id,
        observation: "first\nsecond",
        key: "multiline",
      });
      expect(multiline.ok).toBe(false);
      if (!multiline.ok) expect(multiline.error.code).toBe("validation_error");
      expect(
        counts(v, id),
        "a rejected multiline add must write neither a line nor an interval",
      ).toEqual([0, 0]);
    } finally {
      v.cleanup();
    }
  });

  it("add_observation REJECTS a whitespace-only observation instead of silently accepting it and dropping the interval row", async () => {
    const v = makeM5Vault();
    try {
      const created = await v.call("create_entity", {
        vault: "test",
        type: "probe",
        name: "append-blank",
        materialize: false,
      });
      if (!created.ok) throw new Error("create failed");
      const id = (created.data as { entity_id: string }).entity_id;
      const blank = await v.call("add_observation", {
        vault: "test",
        entity_id: id,
        observation: "   ",
      });
      expect(blank.ok).toBe(false);
      if (!blank.ok) expect(blank.error.code).toBe("validation_error");
      expect(
        counts(v, id),
        "a rejected blank add must write neither a line nor an interval",
      ).toEqual([0, 0]);
    } finally {
      v.cleanup();
    }
  });

  it("the import keyed/unkeyed partition reorders input but keeps text and intervals correlated", async () => {
    const h = makeMemoryImportHarness();
    try {
      const parsed = {
        entities: [
          {
            sourcePath: "mixed.md",
            entityType: "probe",
            name: "mixed-import",
            observations: [
              { text: "keyed first", key: "first" },
              { text: "unkeyed middle", key: null },
              { text: "keyed last", key: "last" },
            ],
            relations: [],
          },
        ],
        skipped: [],
      };
      const report = await applyImport(parsed, {
        vault: "test",
        adapter: "basic-memory",
        dispatch: h.dispatch,
        applied: true,
        now: () => "2026-09-25T00:00:00.000Z",
      });
      expect(report.entities[0]?.action).toBe("create");
      const got = await h.dispatch("get_entity", {
        vault: "test",
        type: "probe",
        name: "mixed-import",
      });
      if (!got.ok) throw new Error(`get failed: ${JSON.stringify(got.error)}`);
      expect(
        (
          got.data as { observations: Array<{ text: string; key: string | null }> }
        ).observations.map(({ text, key }) => ({ text, key })),
      ).toEqual([
        { text: "unkeyed middle", key: null },
        { text: "keyed first", key: "first" },
        { text: "keyed last", key: "last" },
      ]);
      const second = await applyImport(parsed, {
        vault: "test",
        adapter: "basic-memory",
        dispatch: h.dispatch,
        applied: true,
        now: () => "2026-09-26T00:00:00.000Z",
      });
      expect(second.entities[0]?.observationsToAdd).toBe(0);
      const entity = h.db
        .prepare("SELECT id, observations FROM memory_entities WHERE name = 'mixed-import'")
        .get() as { id: string; observations: string };
      const intervals = h.db
        .prepare("SELECT count(*) AS n FROM memory_observation_intervals WHERE entity_id = ?")
        .get(entity.id) as { n: number };
      expect([parseObservations(entity.observations).length, intervals.n]).toEqual([3, 3]);
    } finally {
      h.cleanup();
    }
  });

  it("adapter trimming and whitespace collapse produce one safe stored line per parsed observation", async () => {
    const h = makeMemoryImportHarness();
    try {
      const claude = parseClaudeCodeMemoryFile(
        "---\nname: collapsed\nmetadata:\n  type: probe\n---\nfirst line\n\nsecond\tline\n",
        "claude.md",
      );
      const basic = parseBasicMemoryFile(
        "---\ntitle: trimmed\ntype: probe\n---\n## Observations\n- [Kind] a keyed fact    \n\n- an unkeyed fact    \n",
        "basic.md",
      );
      if (!claude.ok || !basic.ok) throw new Error("fixture parsing failed");
      expect(claude.entity.observations).toEqual([{ text: "first line second line", key: null }]);
      expect(basic.entity.observations).toEqual([
        { text: "a keyed fact", key: "kind" },
        { text: "an unkeyed fact", key: null },
      ]);
      const report = await applyImport(
        { entities: [claude.entity, basic.entity], skipped: [] },
        {
          vault: "test",
          adapter: "basic-memory",
          dispatch: h.dispatch,
          applied: true,
          now: () => "2026-09-25T00:00:00.000Z",
        },
      );
      expect(report.entities.map((entity) => entity.action)).toEqual(["create", "create"]);
      for (const name of ["collapsed", "trimmed"]) {
        const entity = h.db
          .prepare("SELECT id, observations FROM memory_entities WHERE name = ?")
          .get(name) as { id: string; observations: string };
        const intervals = h.db
          .prepare("SELECT count(*) AS n FROM memory_observation_intervals WHERE entity_id = ?")
          .get(entity.id) as { n: number };
        expect(parseObservations(entity.observations)).toHaveLength(intervals.n);
      }
    } finally {
      h.cleanup();
    }
  });
});

describe("THE-1130 migration verification", () => {
  it("is registered at the CACHE tail and its JS postApply backfills exactly parseObservations order", () => {
    const file = "20260925_002_memory_observation_intervals.sql";
    expect(CACHE_MIGRATION_FILES.at(-1)).toBe(file);
    expect(CACHE_MIGRATION_FILES.filter((name) => name === file)).toHaveLength(1);
    const db = openMemoryDb();
    const prefix = CACHE_MIGRATION_FILES.slice(0, -1);
    const readSql = (name: string): string =>
      readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");
    runMigrations(
      db,
      prefix.map((name) => ({ version: versionOf(name), sql: readSql(name) })),
    );
    // A tab-only "blank" line and a \r\n line ending: SQLite's trim() (ASCII space only) and JS
    // .trim() (also strips tab/CR) disagree on this exact input — the fixture that caught it.
    const raw = "  first fact  \n\n\t \n second fact\r\nthird fact  \n";
    db.prepare(
      `INSERT INTO memory_entities
       (id, vault_id, entity_type, name, observations, materialize, vault_path, created_at, updated_at)
       VALUES ('fixture', 'v', 't', 'n', ?, 0, NULL, 1234, 1234)`,
    ).run(raw);
    runMigrations(db, [
      { version: versionOf(file), sql: readSql(file), postApply: backfillObservationIntervalsJs },
    ]);
    const rows = db
      .prepare(
        `SELECT key, valid_from, valid_to, superseded_by
         FROM memory_observation_intervals WHERE entity_id = 'fixture' ORDER BY id`,
      )
      .all() as Array<{
      key: string | null;
      valid_from: number;
      valid_to: number | null;
      superseded_by: string | null;
    }>;
    expect(parseObservations(raw)).toEqual(["first fact", "second fact", "third fact"]);
    expect(rows).toEqual(
      parseObservations(raw).map(() => ({
        key: null,
        valid_from: 1234,
        valid_to: null,
        superseded_by: null,
      })),
    );
    // The JS postApply also rewrites the blob to its own normalized parse (see that function's own
    // comment) — a future re-parse of the stored bytes can never again disagree with this backfill.
    const stored = db
      .prepare("SELECT observations FROM memory_entities WHERE id = 'fixture'")
      .get() as { observations: string };
    expect(stored.observations).toBe("first fact\nsecond fact\nthird fact");
  });
});
