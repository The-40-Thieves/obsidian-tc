import { describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { planRejudge, rejudgeContradictions } from "../src/plane/contradiction-rejudge";
import { compileEgressFilter } from "../src/plane/egress-filter";
import type { GatewayCompletionRequest } from "../src/plane/gateway";
import {
  buildJudgeRequest,
  checkContradictions,
  type IndexedChunk,
} from "../src/plane/jobs/contradiction";
import { planSynthesis } from "../src/plane/jobs/synthesis";
import { openContradictions } from "../src/runtime/advisory-sweep";
import { floatBlob } from "../src/search/vec";
import { openContradictionsForPaths } from "../src/tools/m7/knowledge/retrieval-runtime";
import { contentHash } from "../src/vault/paths";
import { openMemoryDb } from "./helpers";

const RESOLVED = "openai/gpt-6-sol";

function freshDb(): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  return db;
}

function addChunk(db: Database, id: string, path: string, content: string, vec?: number[]): void {
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, 'v1', ?, '0', '[]', ?, ?, 1, 0, 0)",
  ).run(id, path, content, `h-${id}`);
  if (vec)
    db.prepare(
      "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, 'm', ?, ?, 1, 0)",
    ).run(id, vec.length, floatBlob(vec));
}

/** One flagged pair, as the OLD judge would have stored it: both chunks present, shas matching. */
function addFlag(
  db: Database,
  n: number,
  verdict: "contradiction" | "tension" = "contradiction",
  model = "judge",
): string {
  const a = `s${n}`;
  const b = `c${n}`;
  const ca = `source ${n}`;
  const cb = `conflict ${n}`;
  addChunk(db, a, `S${n}.md`, ca);
  addChunk(db, b, `C${n}.md`, cb);
  const id = `ctr_${n}`;
  db.prepare(
    "INSERT INTO contradictions (id, vault_id, source_chunk_id, source_path, conflict_chunk_id, conflict_path, source_content_sha, conflict_content_sha, cosine_similarity, judge_verdict, judge_rationale, judge_model, status, detected_at) VALUES (?, 'v1', ?, ?, ?, ?, ?, ?, 0.9, ?, 'old rationale', ?, 'open', ?)",
  ).run(id, a, `S${n}.md`, b, `C${n}.md`, contentHash(ca), contentHash(cb), verdict, model, n);
  return id;
}

interface Row {
  id: string;
  status: string;
  judge_verdict: string;
  judge_rationale: string | null;
  judge_model: string | null;
  rejudged_at: number | null;
  resolved_at: number | null;
  resolution_reason: string | null;
}
const rows = (db: Database): Row[] =>
  db.prepare("SELECT * FROM contradictions ORDER BY id").all() as Row[];
const byId = (db: Database, id: string): Row => rows(db).find((r) => r.id === id) as Row;

/** A stub judge answering per fragment content, counting calls. */
function stubJudge(answers: Record<string, string | Error>) {
  const calls: GatewayCompletionRequest[] = [];
  const judge = async (req: GatewayCompletionRequest) => {
    calls.push(req);
    const user = req.messages[1]?.content ?? "";
    const key = Object.keys(answers).find((k) => user.includes(k));
    const ans = key === undefined ? undefined : answers[key];
    if (ans instanceof Error) throw ans;
    return { text: ans ?? '{"kind":"no_conflict","rationale":"default"}', model: RESOLVED };
  };
  return { judge, calls };
}

const NO = '{"kind":"no_conflict","rationale":"compatible reports"}';
const TENSION = '{"kind":"tension","rationale":"different emphasis"}';
const CONTRA = '{"kind":"contradiction","rationale":"A negates B"}';

describe("contradiction rejudge — provenance on new detections", () => {
  it("the detector stores the model the judge reported (resolved), not a role alias", async () => {
    const db = freshDb();
    addChunk(db, "a", "A.md", "alpha", [1, 0, 0]);
    addChunk(db, "b", "B.md", "beta", [0.95, 0.312, 0]);
    const judge = async () => ({ text: CONTRA, model: RESOLVED });
    const stats = await checkContradictions(
      { db, roles: { extract: judge, synthesize: judge, judge }, now: () => 5 },
      "v1",
      [{ id: "a", path: "A.md", content: "alpha", embedding: [1, 0, 0] } as IndexedChunk],
    );
    expect(stats.flagged).toBe(1);
    expect(rows(db)[0]?.judge_model).toBe(RESOLVED);
  });
});

describe("contradiction rejudge — dry run", () => {
  it("counts everything, makes zero gateway calls and changes no row", () => {
    const db = freshDb();
    addFlag(db, 1);
    addFlag(db, 2, "tension");
    const stale = addFlag(db, 3);
    db.prepare("UPDATE chunks SET content = 'edited' WHERE id = 's3'").run();
    const before = JSON.stringify(rows(db));
    const { counts } = planRejudge(db, {});
    expect(counts).toMatchObject({
      open: 3,
      openByVerdict: { contradiction: 2, tension: 1 },
      alreadyRejudged: 0,
      stale: 1,
      excluded: 0,
      eligible: 2,
    });
    expect(JSON.stringify(rows(db))).toBe(before);
    expect(byId(db, stale).status).toBe("open");
  });

  it("separates already-ruled rows, other-model rows, excluded paths and the limit", () => {
    const db = freshDb();
    addFlag(db, 1);
    addFlag(db, 2);
    addFlag(db, 3, "contradiction", "openai/gpt-6-sol");
    addFlag(db, 4);
    addFlag(db, 5);
    db.prepare("UPDATE contradictions SET rejudged_at = 9 WHERE id = 'ctr_2'").run();
    const filter = compileEgressFilter(["S4.md"]);
    const { counts } = planRejudge(db, { judgeModel: "judge", limit: 1 }, filter);
    expect(counts).toMatchObject({
      alreadyRejudged: 1,
      otherModel: 1,
      excluded: 1,
      stale: 0,
      eligible: 1, // ctr_1 and ctr_5 remain; limit 1
    });
  });
});

describe("contradiction rejudge — real run", () => {
  it("updates confirmed rows, dismisses no_conflict rows with a reason, records the resolved model", async () => {
    const db = freshDb();
    addFlag(db, 1, "contradiction"); // -> no_conflict: dismissed
    addFlag(db, 2, "contradiction"); // -> tension: updated
    addFlag(db, 3, "tension"); // -> contradiction: updated
    const { judge, calls } = stubJudge({ "source 1": NO, "source 2": TENSION, "source 3": CONTRA });
    const stats = await rejudgeContradictions(
      { db, judge, now: () => 1000, sleepFn: async () => {} },
      {},
    );
    expect(calls).toHaveLength(3);
    expect(stats).toMatchObject({
      judged: 3,
      confirmed: 2,
      dismissed: 1,
      unjudged: 0,
      models: { [RESOLVED]: 3 },
      openByVerdict: { contradiction: 2, tension: 1 },
      openByVerdictAfter: { tension: 1, contradiction: 1 },
    });

    const dismissed = byId(db, "ctr_1");
    expect(dismissed).toMatchObject({
      status: "dismissed",
      resolved_at: 1000,
      rejudged_at: 1000,
      // the ORIGINAL flag is kept as the audit trail
      judge_verdict: "contradiction",
      judge_rationale: "old rationale",
      judge_model: "judge",
    });
    expect(dismissed.resolution_reason).toBe(
      `rejudge: no_conflict (${RESOLVED}) — compatible reports`,
    );

    expect(byId(db, "ctr_2")).toMatchObject({
      status: "open",
      judge_verdict: "tension",
      judge_rationale: "different emphasis",
      judge_model: RESOLVED,
      rejudged_at: 1000,
      resolution_reason: null,
    });
    expect(byId(db, "ctr_3")).toMatchObject({
      judge_verdict: "contradiction",
      judge_model: RESOLVED,
    });
  });

  it("builds the request with the detector's own helper and system prompt", async () => {
    const db = freshDb();
    addFlag(db, 1);
    const { judge, calls } = stubJudge({});
    await rejudgeContradictions({ db, judge, now: () => 1, sleepFn: async () => {} }, {});
    expect(calls[0]).toEqual(
      buildJudgeRequest(
        { path: "S1.md", content: "source 1" },
        { path: "C1.md", content: "conflict 1" },
      ),
    );
    // ...and that is the same system prompt the detector sends.
    const seen: GatewayCompletionRequest[] = [];
    const rec = async (r: GatewayCompletionRequest) => {
      seen.push(r);
      return { text: NO, model: "m" };
    };
    const db2 = freshDb();
    addChunk(db2, "a", "A.md", "alpha", [1, 0, 0]);
    addChunk(db2, "b", "B.md", "beta", [0.95, 0.312, 0]);
    await checkContradictions(
      { db: db2, roles: { extract: rec, synthesize: rec, judge: rec }, now: () => 1 },
      "v1",
      [{ id: "a", path: "A.md", content: "alpha", embedding: [1, 0, 0] }],
    );
    expect(seen[0]?.messages[0]).toEqual(calls[0]?.messages[0]);
  });

  it("is resume-safe: a second run rules only on rows the first could not", async () => {
    const db = freshDb();
    addFlag(db, 1);
    addFlag(db, 2);
    addFlag(db, 3);
    const first = stubJudge({
      "source 1": NO,
      "source 2": new Error("gateway down"),
      "source 3": "not json at all",
    });
    const s1 = await rejudgeContradictions(
      { db, judge: first.judge, now: () => 1, sleepFn: async () => {} },
      {},
    );
    expect(s1).toMatchObject({ judged: 1, dismissed: 1, unjudged: 2, judgeErrors: 1 });
    // Unjudged rows are untouched — a failure is never recorded as a verdict.
    expect(byId(db, "ctr_2")).toMatchObject({ status: "open", rejudged_at: null });
    expect(byId(db, "ctr_3")).toMatchObject({ status: "open", rejudged_at: null });

    const second = stubJudge({ "source 2": CONTRA, "source 3": TENSION });
    const s2 = await rejudgeContradictions(
      { db, judge: second.judge, now: () => 2, sleepFn: async () => {} },
      {},
    );
    expect(second.calls).toHaveLength(2); // ctr_1 (dismissed) is not asked again
    expect(s2).toMatchObject({ judged: 2, confirmed: 2, unjudged: 0, alreadyRejudged: 0 });

    const third = stubJudge({});
    const s3 = await rejudgeContradictions(
      { db, judge: third.judge, now: () => 3, sleepFn: async () => {} },
      {},
    );
    expect(third.calls).toHaveLength(0); // idempotent: everything has a ruling
    expect(s3).toMatchObject({ judged: 0, eligible: 0, alreadyRejudged: 2 });
    expect(byId(db, "ctr_2").rejudged_at).toBe(2);
  });

  it("never sends an excluded or stale pair and leaves those rows open", async () => {
    const db = freshDb();
    addFlag(db, 1);
    addFlag(db, 2);
    addFlag(db, 3);
    db.prepare("UPDATE chunks SET content = 'edited since' WHERE id = 'c2'").run();
    const { judge, calls } = stubJudge({});
    const stats = await rejudgeContradictions(
      {
        db,
        judge,
        now: () => 1,
        sleepFn: async () => {},
        excludeFilter: compileEgressFilter(["C3.md"]),
      },
      {},
    );
    expect(calls).toHaveLength(1);
    expect(stats).toMatchObject({ stale: 1, excluded: 1, judged: 1 });
    expect(byId(db, "ctr_2").status).toBe("open");
    expect(byId(db, "ctr_3").status).toBe("open");
  });

  it("honours --limit and pauses between calls (rate limit)", async () => {
    const db = freshDb();
    for (let i = 1; i <= 4; i++) addFlag(db, i);
    const { judge, calls } = stubJudge({});
    const sleeps: number[] = [];
    await rejudgeContradictions(
      {
        db,
        judge,
        now: () => 1,
        sleepFn: async (ms) => {
          sleeps.push(ms);
        },
      },
      { limit: 3, concurrency: 1, delayMs: 40 },
    );
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([40, 40, 40]);
    // The oldest rows were taken first; ctr_4 is still waiting.
    expect(byId(db, "ctr_4").rejudged_at).toBeNull();
  });
});

describe("consumers ignore dismissed rows", () => {
  it("list_contradictions / challenge evidence, the advisory sweep and consolidate's synthesis all skip a dismissed row", async () => {
    const db = freshDb();
    addFlag(db, 1); // will be dismissed
    addFlag(db, 2); // stays flagged
    const paths = ["S1.md", "C1.md", "S2.md", "C2.md"];
    const readable = () => true;
    const countAll = () => ({
      forPaths: openContradictionsForPaths(db, "v1", paths, readable).map((c) => c.id),
      advisory: openContradictions(db, "v1", 50).map((c) => c.ref),
      synthesis: planSynthesis({ db, roles: null, now: () => 1 })[0]?.contradictions_candidate,
    });
    expect(countAll()).toEqual({
      forPaths: ["ctr_1", "ctr_2"],
      advisory: ["ctr_2", "ctr_1"],
      synthesis: 2,
    });

    const { judge } = stubJudge({ "source 1": NO, "source 2": CONTRA });
    await rejudgeContradictions({ db, judge, now: () => 9, sleepFn: async () => {} }, {});

    expect(countAll()).toEqual({ forPaths: ["ctr_2"], advisory: ["ctr_2"], synthesis: 1 });
  });
});
