// THE-170 — citation inference. Pins ROUGE-L, the two-stage gate (stage-1 filter, stage-2
// judge with the 5% parse kill switch), scope isolation (only the targeted session's rows
// stamp), and the stage-1-only mode when no judge is configured.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import {
  inferCitations,
  maxBlockCosine,
  prepareBlocks,
  prepareTranscript,
  rougeL,
  rougeLPrepared,
} from "../src/experiential/citation";
import { cosineSimilarity } from "../src/search/native";
import { openMemoryDb } from "./helpers";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");
const EXP_CHAIN = [
  { version: "20260626_001", sql: read("20260626_001_experiential_init.sql") },
  { version: "20260711_001", sql: read("20260711_001_experiential_outcome.sql") },
  { version: "20260711_002", sql: read("20260711_002_agent_episodes.sql") },
  // This fixture is a deliberate MINIMAL chain, not the production one, so a new experiential
  // migration does not automatically appear here. 20260731_001 adds citation_state, which
  // inferCitations now writes — without it every stamp fails "no such column".
  { version: "20260731_001", sql: read("20260731_001_citation_state.sql") },
];
const NOW = 1_700_000_000_000;

function edb0(): Database {
  const db = openMemoryDb();
  runMigrations(db, EXP_CHAIN);
  return db;
}

// Minimal authored-cache shape: only the columns citation-infer reads.
function cacheDb0(): Database {
  const db = openMemoryDb();
  db.exec(
    "CREATE TABLE chunks (id TEXT PRIMARY KEY, content TEXT NOT NULL);" +
      "CREATE TABLE chunk_embeddings (chunk_id TEXT NOT NULL, embedding BLOB NOT NULL, is_active INTEGER NOT NULL DEFAULT 1);",
  );
  return db;
}

function seedRetrieval(edb: Database, id: string, chunkId: string, session: string, at = NOW) {
  edb
    .prepare(
      "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, session_id, surface_type, query_text, rank_in_results) VALUES (?, ?, ?, ?, 'search_semantic', 'q', 1)",
    )
    .run(id, chunkId, at, session);
}

const TRANSCRIPT = [
  "Here is what I found about the finances.",
  "The quarterly revenue grew twelve percent in march according to the ledger notes.",
  "Let me know if you want the full breakdown.",
].join("\n\n");

const CHUNK_CITED = "quarterly revenue grew twelve percent in march per the ledger";
const CHUNK_UNCITED = "kanban plugin board column cards preserved verbatim settings block";

const rows = (edb: Database) =>
  edb
    .prepare(
      "SELECT id, chunk_id, cited_in_response, citation_score FROM chunk_retrievals ORDER BY id",
    )
    .all() as Array<{
    id: string;
    chunk_id: string;
    cited_in_response: number | null;
    citation_score: number | null;
  }>;

describe("citation inference (THE-170)", () => {
  it("rougeL: identical -> 1, disjoint -> 0, overlap in between", () => {
    expect(rougeL("alpha beta gamma", "alpha beta gamma")).toBe(1);
    expect(rougeL("alpha beta gamma", "delta epsilon zeta")).toBe(0);
    const mid = rougeL(CHUNK_CITED, TRANSCRIPT);
    expect(mid).toBeGreaterThan(0.05);
    expect(mid).toBeLessThan(1);
    expect(rougeL(CHUNK_UNCITED, TRANSCRIPT)).toBeLessThan(0.05);
  });

  it("rougeLPrepared is IDENTICAL to rougeL for every shape", () => {
    // The hoisted path must be a pure refactor: same score, not merely a close one. This is the
    // assertion that makes the speedup meaningful — without it, "faster" and "different" are
    // indistinguishable.
    const prepared = prepareTranscript(TRANSCRIPT);
    for (const chunk of [
      CHUNK_CITED,
      CHUNK_UNCITED,
      "alpha beta gamma",
      "",
      "quarterly",
      "revenue revenue revenue",
      TRANSCRIPT,
    ]) {
      expect(rougeLPrepared(chunk, prepared)).toBe(rougeL(chunk, TRANSCRIPT));
    }
  });

  it("an unknown chunk token must not collide with transcript token id 0", () => {
    // Interning maps transcript tokens to 0..n-1, so a chunk token that is ABSENT needs a
    // sentinel outside that range. A `?? 0` fallback would silently alias every unknown token
    // onto the first transcript token and inflate the score — this pins the sentinel.
    const prepared = prepareTranscript("alpha beta gamma"); // alpha -> id 0
    expect(rougeLPrepared("zeta", prepared)).toBe(0);
    expect(rougeLPrepared("zeta omega", prepared)).toBe(0);
    // ...while a token that IS present still matches.
    expect(rougeLPrepared("alpha", prepared)).toBeGreaterThan(0);
  });

  it("prepareTranscript caps at MAX_TRANSCRIPT_TOKENS like the inline tokenizer did", () => {
    const long = Array.from({ length: 9000 }, (_, i) => `w${i}`).join(" ");
    expect(prepareTranscript(long).ids.length).toBe(6000);
  });

  it("maxBlockCosine matches the per-pair loop it replaces", () => {
    // The cosine leg used to call cosineSimilarity once per (block, chunk) pair — up to 48 native
    // crossings per chunk, the shape THE-420 measured as SLOWER than JS. One cosineBatch crossing
    // must produce the same maximum. Blocks narrow f64 -> f32 crossing the boundary, so this is
    // held to THE-504's measured epsilon rather than to bit-identity.
    const dim = 16;
    const mk = (seed: number) =>
      Array.from({ length: dim }, (_, i) => Math.sin(seed * 7.13 + i * 1.7));
    const blocks = [mk(1), mk(2), mk(3), mk(4)];
    // The chunk is a PERTURBED COPY of blocks[2], so the true maximum is a strong positive match
    // against a known block rather than whatever four arbitrary vectors happen to produce. A
    // fixture of unrelated vectors can land on an all-negative maximum, which would let a
    // degenerate implementation pass the agreement check while scoring nothing.
    const vec = new Float32Array((blocks[2] as number[]).map((x, i) => x + (i % 3) * 0.01));

    const prepared = prepareBlocks(blocks);
    expect(prepared).not.toBeNull();
    const batched = maxBlockCosine(vec, prepared as NonNullable<typeof prepared>);

    let pairwise = Number.NEGATIVE_INFINITY;
    for (const bv of blocks) pairwise = Math.max(pairwise, cosineSimilarity(bv, vec));

    expect(Math.abs(batched - pairwise)).toBeLessThan(1e-6);
    // ...and it is a real signal, not a degenerate 0 that would pass trivially.
    expect(batched).toBeGreaterThan(0.1);
  });

  it("a chunk whose width differs from the blocks scores 0, not null", () => {
    // The per-pair loop produced 0 here (cosineSimilarity returns 0 on a length mismatch, and the
    // max over all-zero is 0), so `cosine` stayed a number. Pinning that: a null would change the
    // Assessment shape even though `pass` is unaffected at the 0.30 threshold.
    const prepared = prepareBlocks([
      [1, 0, 0, 0],
      [0, 1, 0, 0],
    ]);
    expect(prepared).not.toBeNull();
    const wrongWidth = new Float32Array([1, 0]); // dim 2 vs blocks' dim 4
    expect(maxBlockCosine(wrongWidth, prepared as NonNullable<typeof prepared>)).toBe(0);
  });

  it("prepareBlocks returns null for shapes cosineBatch cannot express", () => {
    expect(prepareBlocks([])).toBeNull(); // no blocks
    expect(
      prepareBlocks([
        [1, 2],
        [1, 2, 3],
      ]),
    ).toBeNull(); // ragged -> caller keeps pairwise
    expect(prepareBlocks([[], []])).toBeNull(); // zero width
    expect(
      prepareBlocks([
        [1, 2],
        [3, 4],
      ]),
    ).not.toBeNull();
  });

  it("two-stage: judge stamps survivors, negatives stamp 0, other sessions untouched", async () => {
    const edb = edb0();
    const cacheDb = cacheDb0();
    cacheDb.prepare("INSERT INTO chunks (id, content) VALUES (?, ?)").run("cA", CHUNK_CITED);
    cacheDb.prepare("INSERT INTO chunks (id, content) VALUES (?, ?)").run("cB", CHUNK_UNCITED);
    seedRetrieval(edb, "r1", "cA", "s1");
    seedRetrieval(edb, "r2", "cB", "s1");
    seedRetrieval(edb, "r3", "cA", "s2"); // other session — must stay NULL

    const stats = await inferCitations({
      edb,
      cacheDb,
      transcript: TRANSCRIPT,
      sessionId: "s1",
      judge: async () => ({ text: '{"cited": true, "score": 0.9}', model: "fake" }),
    });
    expect(stats).toMatchObject({
      scoped: 2,
      stage1Pass: 1,
      judged: 1,
      cited: 1,
      parseFailures: 0,
      aborted: false,
    });
    const r = rows(edb);
    expect(r.find((x) => x.id === "r1")).toMatchObject({
      cited_in_response: 1,
      citation_score: 0.9,
    });
    expect(r.find((x) => x.id === "r2")?.cited_in_response).toBe(0);
    expect(r.find((x) => x.id === "r3")?.cited_in_response).toBeNull();
  });

  it("kill switch: garbage judge output aborts survivor stamping, negatives still stamp", async () => {
    const edb = edb0();
    const cacheDb = cacheDb0();
    cacheDb.prepare("INSERT INTO chunks (id, content) VALUES (?, ?)").run("cA", CHUNK_CITED);
    cacheDb.prepare("INSERT INTO chunks (id, content) VALUES (?, ?)").run("cB", CHUNK_UNCITED);
    seedRetrieval(edb, "r1", "cA", "s1");
    seedRetrieval(edb, "r2", "cB", "s1");

    const stats = await inferCitations({
      edb,
      cacheDb,
      transcript: TRANSCRIPT,
      sessionId: "s1",
      // THE-621 item 2: this pass judges ONE survivor, which is below the shipped 10-judgement
      // floor. The floor is asserted separately below; what this test pins is the abort MECHANIC
      // (survivors left NULL, negatives still stamped), so it opts into the old sensitivity
      // explicitly rather than silently depending on it.
      minJudgedForKill: 1,
      judge: async () => ({ text: "definitely not json", model: "fake" }),
    });
    expect(stats.aborted).toBe(true);
    expect(stats.parseFailures).toBe(1);
    const r = rows(edb);
    expect(r.find((x) => x.id === "r1")?.cited_in_response).toBeNull(); // clean rerun possible
    expect(r.find((x) => x.id === "r2")?.cited_in_response).toBe(0);
  });

  it("stage-1-only mode (no judge) stamps survivors cited=1 with the stage-1 score", async () => {
    const edb = edb0();
    const cacheDb = cacheDb0();
    cacheDb.prepare("INSERT INTO chunks (id, content) VALUES (?, ?)").run("cA", CHUNK_CITED);
    seedRetrieval(edb, "r1", "cA", "s1");
    const stats = await inferCitations({
      edb,
      cacheDb,
      transcript: TRANSCRIPT,
      sessionId: "s1",
    });
    expect(stats).toMatchObject({ scoped: 1, stage1Pass: 1, judged: 0, cited: 1 });
    const r = rows(edb)[0];
    expect(r?.cited_in_response).toBe(1);
    expect(r?.citation_score).toBeGreaterThan(0.05); // the rouge score, cosine absent
  });

  it("windowMs scope works when session ids are null", async () => {
    const edb = edb0();
    const cacheDb = cacheDb0();
    cacheDb.prepare("INSERT INTO chunks (id, content) VALUES (?, ?)").run("cA", CHUNK_CITED);
    edb
      .prepare(
        "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, surface_type, query_text, rank_in_results) VALUES ('r1', 'cA', ?, 'search_semantic', 'q', 1)",
      )
      .run(NOW);
    const stats = await inferCitations({
      edb,
      cacheDb,
      transcript: TRANSCRIPT,
      windowMs: [NOW - 1000, NOW + 1000],
    });
    expect(stats.cited).toBe(1);
  });

  // THE-617 item 3 — the module-local MAX_JUDGED=25 had no override anywhere (unlike
  // reflect.ts's identically-shaped constant, which reflect's CLI already exposes via
  // --max-judged). Threaded the same way: an opts override here, --max-judged on the
  // citation-infer CLI.
  it("maxJudged caps how many stage-1 survivors get judged, overriding the default", async () => {
    const edb = edb0();
    const cacheDb = cacheDb0();
    const chunkIds = ["cA", "cB", "cC"];
    for (const id of chunkIds) {
      cacheDb.prepare("INSERT INTO chunks (id, content) VALUES (?, ?)").run(id, CHUNK_CITED);
      seedRetrieval(edb, `r-${id}`, id, "s1");
    }
    let judgeCalls = 0;
    const stats = await inferCitations({
      edb,
      cacheDb,
      transcript: TRANSCRIPT,
      sessionId: "s1",
      maxJudged: 2,
      judge: async () => {
        judgeCalls += 1;
        return { text: '{"cited": true, "score": 0.9}', model: "fake" };
      },
    });
    expect(stats.stage1Pass).toBe(3); // all three survive stage 1
    expect(stats.judged).toBe(2); // but only maxJudged of them are actually judged
    expect(judgeCalls).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// The provenance axis (20260731_001). `cited_in_response`'s `1` conflated "the judge confirmed
// this against the transcript" with "it cleared the cheap stage-1 filter and no judge existed" —
// and every downstream reader (chunk_access_stats, contribution.ts, metrics.ts) counts `= 1`, so
// the absence of a gateway silently manufactures citations.
//
// This column separates the two WITHOUT changing a single existing number. The tests above are
// the proof of that half: they assert the exact prior cited_in_response values and all still pass
// untouched. The tests below pin the new half.
// ---------------------------------------------------------------------------------------------
const states = (edb: Database) =>
  edb
    .prepare("SELECT id, cited_in_response, citation_state FROM chunk_retrievals ORDER BY id")
    .all() as Array<{
    id: string;
    cited_in_response: number | null;
    citation_state: string | null;
  }>;

describe("citation provenance (citation_state)", () => {
  function seeded() {
    const edb = edb0();
    const cacheDb = cacheDb0();
    cacheDb.prepare("INSERT INTO chunks (id, content) VALUES (?, ?)").run("cA", CHUNK_CITED);
    cacheDb.prepare("INSERT INTO chunks (id, content) VALUES (?, ?)").run("cB", CHUNK_UNCITED);
    seedRetrieval(edb, "r1", "cA", "s1");
    seedRetrieval(edb, "r2", "cB", "s1");
    return { edb, cacheDb };
  }

  it("a judge-affirmed survivor is 'confirmed'; a stage-1 negative is 'rejected'", async () => {
    const { edb, cacheDb } = seeded();
    await inferCitations({
      edb,
      cacheDb,
      transcript: TRANSCRIPT,
      sessionId: "s1",
      judge: async () => ({ text: '{"cited": true, "score": 0.9}', model: "fake" }),
    });
    const s = states(edb);
    expect(s.find((x) => x.id === "r1")).toMatchObject({
      cited_in_response: 1,
      citation_state: "confirmed",
    });
    expect(s.find((x) => x.id === "r2")).toMatchObject({
      cited_in_response: 0,
      citation_state: "rejected",
    });
  });

  it("a judge that says NOT cited is 'rejected', not merely unstamped", async () => {
    const { edb, cacheDb } = seeded();
    await inferCitations({
      edb,
      cacheDb,
      transcript: TRANSCRIPT,
      sessionId: "s1",
      judge: async () => ({ text: '{"cited": false, "score": 0.1}', model: "fake" }),
    });
    expect(states(edb).find((x) => x.id === "r1")).toMatchObject({
      cited_in_response: 0,
      citation_state: "rejected",
    });
  });

  it("⭐ a stage-1-only survivor is 'candidate' — still counted, now visibly unjudged", async () => {
    // THE POINT OF THE COLUMN. cited_in_response stays 1, so chunk_access_stats /
    // contribution.ts / metrics.ts count it exactly as before — but the row no longer claims a
    // judge ever looked at it. Whether these should stop counting is a separate, evidence-gated
    // decision; this makes the question answerable.
    const { edb, cacheDb } = seeded();
    const stats = await inferCitations({ edb, cacheDb, transcript: TRANSCRIPT, sessionId: "s1" });
    expect(stats.judged).toBe(0);
    expect(states(edb).find((x) => x.id === "r1")).toMatchObject({
      cited_in_response: 1,
      citation_state: "candidate",
    });
  });

  it("makes 'how much of our citation signal was never judged?' a query", async () => {
    const { edb, cacheDb } = seeded();
    await inferCitations({ edb, cacheDb, transcript: TRANSCRIPT, sessionId: "s1" });
    const row = edb
      .prepare(
        `SELECT SUM(CASE WHEN citation_state = 'candidate' THEN 1 ELSE 0 END) AS unjudged,
                SUM(CASE WHEN cited_in_response = 1 THEN 1 ELSE 0 END)         AS counted
         FROM chunk_retrievals`,
      )
      .get() as { unjudged: number; counted: number };
    // Every citation this run produced was unjudged — invisible before this column existed.
    expect(row.counted).toBe(1);
    expect(row.unjudged).toBe(1);
  });

  it("the kill switch leaves BOTH columns NULL — a clean rerun, not a recorded verdict", async () => {
    const { edb, cacheDb } = seeded();
    const stats = await inferCitations({
      edb,
      cacheDb,
      transcript: TRANSCRIPT,
      sessionId: "s1",
      minJudgedForKill: 1, // THE-621: one judgement is below the shipped floor — see above
      judge: async () => ({ text: "definitely not json", model: "fake" }),
    });
    expect(stats.aborted).toBe(true);
    const s = states(edb);
    expect(s.find((x) => x.id === "r1")).toMatchObject({
      cited_in_response: null,
      citation_state: null,
    });
    // The stage-1 negative still stamps, and still records WHY.
    expect(s.find((x) => x.id === "r2")).toMatchObject({
      cited_in_response: 0,
      citation_state: "rejected",
    });
  });

  it("the DB refuses a state outside the declared vocabulary", async () => {
    // The CHECK is what makes 'candidate' mean something: an unknown state cannot be stored, so a
    // future writer cannot quietly invent a fifth meaning the readers do not handle.
    const { edb } = seeded();
    expect(() =>
      edb.prepare("UPDATE chunk_retrievals SET citation_state = 'probably' WHERE id = 'r1'").run(),
    ).toThrow();
    for (const ok of ["confirmed", "rejected", "candidate", "uncertain"]) {
      expect(() =>
        edb.prepare("UPDATE chunk_retrievals SET citation_state = ? WHERE id = 'r1'").run(ok),
      ).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Judge abstention (`allowUncertain`). DARK BY DEFAULT: enabling it changes the judge PROMPT (a
// model-visible input) and moves abstained rows out of the citation count. These tests pin both
// that the default is untouched and that the mechanism works when switched on.
// ---------------------------------------------------------------------------------------------
describe("judge abstention (allowUncertain, dark by default)", () => {
  function seeded() {
    const edb = edb0();
    const cacheDb = cacheDb0();
    cacheDb.prepare("INSERT INTO chunks (id, content) VALUES (?, ?)").run("cA", CHUNK_CITED);
    seedRetrieval(edb, "r1", "cA", "s1");
    return { edb, cacheDb };
  }
  const UNCERTAIN_REPLY = '{"cited": "uncertain", "score": 0.4}';

  it("OFF (default): an abstention is a PARSE FAILURE, exactly as before", async () => {
    // The pre-existing contract. A widened prompt against the old parser would have turned every
    // abstention into this — which is why prompt and parser are gated by the SAME flag.
    const { edb, cacheDb } = seeded();
    const stats = await inferCitations({
      edb,
      cacheDb,
      transcript: TRANSCRIPT,
      sessionId: "s1",
      judge: async () => ({ text: UNCERTAIN_REPLY, model: "fake" }),
    });
    expect(stats.parseFailures).toBe(1);
    expect(stats.uncertain).toBe(0);
    // Unparsed => unstamped => rerunnable, not a recorded verdict.
    const r = states(edb).find((x) => x.id === "r1");
    expect(r?.cited_in_response).toBeNull();
    expect(r?.citation_state).toBeNull();
  });

  it("OFF (default): the judge prompt is byte-identical to the shipped one", async () => {
    // A judge prompt is model-visible input. If the default run ever starts advertising a third
    // answer, every verdict distribution shifts and no test would otherwise notice.
    const { edb, cacheDb } = seeded();
    let seen = "";
    await inferCitations({
      edb,
      cacheDb,
      transcript: TRANSCRIPT,
      sessionId: "s1",
      judge: async (req) => {
        seen = JSON.stringify(req);
        return { text: '{"cited": true, "score": 0.9}', model: "fake" };
      },
    });
    expect(seen).toContain('{\\"cited\\": true|false, \\"score\\"');
    expect(seen).not.toContain("uncertain");
  });

  it("ON: an abstention stamps 'uncertain' and does NOT count as a citation", async () => {
    const { edb, cacheDb } = seeded();
    const stats = await inferCitations({
      edb,
      cacheDb,
      transcript: TRANSCRIPT,
      sessionId: "s1",
      allowUncertain: true,
      judge: async () => ({ text: UNCERTAIN_REPLY, model: "fake" }),
    });
    expect(stats).toMatchObject({ judged: 1, cited: 0, uncertain: 1, parseFailures: 0 });
    expect(states(edb).find((x) => x.id === "r1")).toMatchObject({
      cited_in_response: 0, // an abstention is not a citation...
      citation_state: "uncertain", // ...and is not the judge saying "no", either
    });
  });

  it("ON: the widened contract reaches the judge", async () => {
    const { edb, cacheDb } = seeded();
    let seen = "";
    await inferCitations({
      edb,
      cacheDb,
      transcript: TRANSCRIPT,
      sessionId: "s1",
      allowUncertain: true,
      judge: async (req) => {
        seen = JSON.stringify(req);
        return { text: UNCERTAIN_REPLY, model: "fake" };
      },
    });
    expect(seen).toContain("uncertain");
    expect(seen).toContain("abstention is better than a confident guess");
  });

  it("ON: ordinary true/false verdicts are unaffected", async () => {
    const { edb, cacheDb } = seeded();
    const stats = await inferCitations({
      edb,
      cacheDb,
      transcript: TRANSCRIPT,
      sessionId: "s1",
      allowUncertain: true,
      judge: async () => ({ text: '{"cited": true, "score": 0.9}', model: "fake" }),
    });
    expect(stats).toMatchObject({ cited: 1, uncertain: 0, parseFailures: 0 });
    expect(states(edb).find((x) => x.id === "r1")).toMatchObject({
      cited_in_response: 1,
      citation_state: "confirmed",
    });
  });

  it("ON: garbage is still garbage — the kill switch is not weakened", async () => {
    // Widening the vocabulary must not become a way to launder unparseable output.
    const { edb, cacheDb } = seeded();
    const stats = await inferCitations({
      edb,
      cacheDb,
      transcript: TRANSCRIPT,
      sessionId: "s1",
      allowUncertain: true,
      minJudgedForKill: 1, // THE-621: one judgement is below the shipped floor — see above
      judge: async () => ({ text: '{"cited": "probably", "score": 0.4}', model: "fake" }),
    });
    expect(stats.parseFailures).toBe(1);
    expect(stats.uncertain).toBe(0);
    expect(stats.aborted).toBe(true);
  });
});

describe("stage-2 preflight hardening (THE-621)", () => {
  /** N distinct stage-1 survivors in one session. `content` is per-chunk so a judge can tell them
   *  apart from the request body; every variant still clears the ROUGE floor. */
  function seededMany(n: number, suffix = (i: number) => `w${i}`) {
    const edb = edb0();
    const cacheDb = cacheDb0();
    const ins = cacheDb.prepare("INSERT INTO chunks (id, content) VALUES (?, ?)");
    for (let i = 0; i < n; i++) {
      ins.run(`c${i}`, `${CHUNK_CITED} ${suffix(i)}`);
      seedRetrieval(edb, `r${i}`, `c${i}`, "s1");
    }
    return { edb, cacheDb };
  }
  const CITED_REPLY = { text: '{"cited": true, "score": 0.9}', model: "fake" };
  const GARBAGE_REPLY = { text: "definitely not json", model: "fake" };

  it("item 2: below the floor, one parse failure no longer discards the verdicts that parsed", async () => {
    const { edb, cacheDb } = seededMany(3);
    let call = 0;
    const stats = await inferCitations({
      edb,
      cacheDb,
      transcript: TRANSCRIPT,
      sessionId: "s1",
      judge: async () => {
        call += 1;
        return call === 1 ? GARBAGE_REPLY : CITED_REPLY;
      },
    });
    expect(stats.judged).toBe(3);
    expect(stats.parseFailures).toBe(1); // 1/3 = 33%, far over the 5% ratio...
    expect(stats.aborted).toBe(false); // ...but 3 is under the 10-judgement floor
    expect(stats.cited).toBe(2); // and the two that parsed are stamped, not thrown away
  });

  it("item 2: the floor is a >= boundary — 9 judgements cannot trip it, 10 can", async () => {
    // Pins the comparison itself. An off-by-one (`>` for `>=`) survives every other test here.
    const nine = seededMany(9);
    const a = await inferCitations({
      edb: nine.edb,
      cacheDb: nine.cacheDb,
      transcript: TRANSCRIPT,
      sessionId: "s1",
      judge: async () => GARBAGE_REPLY,
    });
    expect(a.judged).toBe(9);
    expect(a.aborted).toBe(false);

    const ten = seededMany(10);
    const b = await inferCitations({
      edb: ten.edb,
      cacheDb: ten.cacheDb,
      transcript: TRANSCRIPT,
      sessionId: "s1",
      judge: async () => GARBAGE_REPLY,
    });
    expect(b.judged).toBe(10);
    expect(b.aborted).toBe(true);
    // Aborting still means a clean rerun: no survivor carries a verdict.
    expect(rows(ten.edb).every((r) => r.cited_in_response === null)).toBe(true);
  });

  it("item 1: the judge fan-out runs in parallel AND stays under the cap", async () => {
    const { edb, cacheDb } = seededMany(9);
    let inFlight = 0;
    let peak = 0;
    const stats = await inferCitations({
      edb,
      cacheDb,
      transcript: TRANSCRIPT,
      sessionId: "s1",
      judgeConcurrency: 2,
      judge: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
        return CITED_REPLY;
      },
    });
    expect(stats.judged).toBe(9);
    // Exactly 2 catches BOTH regressions: a serial loop peaks at 1, an unbounded Promise.all at 9.
    expect(peak).toBe(2);
  });

  it("item 1: a THROWN judge call does not reject the pool or lose the other verdicts", async () => {
    // The serial loop isolated failures per chunk. A naive Promise.all would surface the throw and
    // discard every sibling verdict in flight, so this is the property most at risk in the rewrite.
    const { edb, cacheDb } = seededMany(4);
    let call = 0;
    const stats = await inferCitations({
      edb,
      cacheDb,
      transcript: TRANSCRIPT,
      sessionId: "s1",
      judge: async () => {
        call += 1;
        if (call === 1) throw new Error("gateway exploded");
        return CITED_REPLY;
      },
    });
    expect(stats.judged).toBe(4);
    expect(stats.parseFailures).toBe(1); // the throw counts as a failure, exactly as before
    expect(stats.cited).toBe(3); // the other three are unaffected
  });

  it("item 1: a verdict binds to its OWN chunk when judges settle out of input order", async () => {
    const edb = edb0();
    const cacheDb = cacheDb0();
    const ins = cacheDb.prepare("INSERT INTO chunks (id, content) VALUES (?, ?)");
    ins.run("cSlow", `${CHUNK_CITED} alpha`);
    ins.run("cFast", `${CHUNK_CITED} beta`);
    seedRetrieval(edb, "rSlow", "cSlow", "s1");
    seedRetrieval(edb, "rFast", "cFast", "s1");

    await inferCitations({
      edb,
      cacheDb,
      transcript: TRANSCRIPT,
      sessionId: "s1",
      judgeConcurrency: 2,
      judge: async (req) => {
        // "alpha" is FIRST in input order and settles LAST. If results were folded by arrival,
        // the two verdicts would transpose and both assertions below would invert.
        if (JSON.stringify(req).includes("alpha")) {
          await new Promise((r) => setTimeout(r, 20));
          return { text: '{"cited": true, "score": 0.91}', model: "fake" };
        }
        return { text: '{"cited": false, "score": 0.12}', model: "fake" };
      },
    });
    const s = states(edb);
    expect(s.find((x) => x.id === "rSlow")).toMatchObject({
      cited_in_response: 1,
      citation_state: "confirmed",
    });
    expect(s.find((x) => x.id === "rFast")).toMatchObject({
      cited_in_response: 0,
      citation_state: "rejected",
    });
  });

  it("item 3: judgeSystem replaces the shipped prompt", async () => {
    const { edb, cacheDb } = seededMany(1);
    let seen = "";
    await inferCitations({
      edb,
      cacheDb,
      transcript: TRANSCRIPT,
      sessionId: "s1",
      judgeSystem: "THE-621 probe prompt. Reply with strict JSON only.",
      judge: async (req) => {
        seen = JSON.stringify(req);
        return CITED_REPLY;
      },
    });
    expect(seen).toContain("THE-621 probe prompt");
    expect(seen).not.toContain("You judge citation");
  });

  it("item 3: the DEFAULT prompt is untouched when judgeSystem is absent", async () => {
    // The override must not become a way to drift the shipped prompt by omission.
    const { edb, cacheDb } = seededMany(1);
    let seen = "";
    await inferCitations({
      edb,
      cacheDb,
      transcript: TRANSCRIPT,
      sessionId: "s1",
      judge: async (req) => {
        seen = JSON.stringify(req);
        return CITED_REPLY;
      },
    });
    expect(seen).toContain("You judge citation");
    expect(seen).not.toContain("uncertain");
  });
});
