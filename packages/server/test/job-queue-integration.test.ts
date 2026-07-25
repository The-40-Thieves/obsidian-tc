// THE-562 #14: the contradiction workload wired through the durable JobQueue, replacing the
// in-memory queue that dropped chunks under backpressure and lost everything on crash. This
// exercises the exact seam cli.ts wires up: enqueue(vaultId, chunk) with idempotencyKey
// `${vaultId}:${chunk.id}:${contentHash(chunk.content)}` -> a "contradiction" handler that calls
// checkContradictions -> the generic runner's claim/dispatch/complete/retry/dead-letter machinery.
//
// The key is content-sensitive, not just `${vaultId}:${chunk.id}` — chunk.id (chunkId(vaultId,
// path, index) in search/indexer.ts) is deterministic from PATH+POSITION, not content, and
// enqueue()'s dedup matches a completed job's row too (jobs are never pruned). An id-only key
// would mean editing a note produces NO new job forever after the first index — silently starving
// re-judging even though the indexer deletes the chunk's prior contradiction flags on every
// re-embed, expecting this hook to regenerate them (see the "re-judges an edited chunk" case
// below).
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { CACHE_MIGRATIONS } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { type GatewayRoles, prompt } from "../src/plane/gateway";
import {
  checkContradictions,
  type IndexedChunk,
  loadChunkForContradiction,
} from "../src/plane/jobs/contradiction";
import { isoWeek, runSynthesis } from "../src/plane/jobs/synthesis";
import { JobQueue } from "../src/scheduler/job-queue";
import { type JobHandler, makeJobRunner } from "../src/scheduler/job-runner";
import { floatBlob } from "../src/search/vec";
import { contentHash } from "../src/vault/paths";
import { openMemoryDb } from "./helpers";

// The exact key construction cli.ts's makeOnIndexed uses — kept as one helper so every test case
// exercises production's actual dedup semantics, not a stand-in opaque string.
function jobKey(vaultId: string, chunk: IndexedChunk): string {
  return `${vaultId}:${chunk.id}:${contentHash(chunk.content)}`;
}

// Verbatim from contradiction-job.test.ts (per the task-3 brief: reuse the fixture builders).
function rolesReturning(text: string): GatewayRoles {
  const r = async () => ({ text, model: "mock" });
  return { extract: r, synthesize: r, judge: r };
}

function addChunk(db: Database, id: string, path: string, vec: number[]): void {
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, 'v1', ?, '0', '[]', ?, ?, 1, 0, 0)",
  ).run(id, path, `body ${id}`, `h-${id}`);
  db.prepare(
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, 'm', ?, ?, 1, 0)",
  ).run(id, vec.length, floatBlob(vec));
}

function setup(roles: GatewayRoles | null) {
  const db = openMemoryDb();
  runMigrations(db, CACHE_MIGRATIONS);
  // The contradiction pair: "a" is the freshly-indexed chunk; "b" is its conflicting neighbor
  // already in the db (checkContradictions finds neighbors FROM THE DB, not from the batch).
  addChunk(db, "a", "A.md", [1, 0, 0]);
  addChunk(db, "b", "B.md", [0.95, 0.312, 0]); // cosine ~0.95 with A -> in [0.85, 0.99)
  const jobQueue = new JobQueue(db, { now: () => 1000 });
  const chunkA: IndexedChunk = { id: "a", path: "A.md", content: "alpha", embedding: [1, 0, 0] };
  const handlers = new Map<string, JobHandler>([
    [
      "contradiction",
      async (job) => {
        // THE-571: mirrors production — the payload carries only ids, and the chunk is re-read at
        // RUN time. A chunk deleted between enqueue and run is a normal race, so it SKIPS rather
        // than throwing (a throw is how the runner dead-letters).
        const { vaultId, chunkId } = job.payload as { vaultId: string; chunkId: string };
        const chunk = loadChunkForContradiction(db, vaultId, chunkId);
        if (!chunk) return;
        await checkContradictions({ db, roles, now: () => 1000 }, vaultId, [chunk]);
      },
    ],
  ]);
  const runner = makeJobRunner({ queue: jobQueue, leaseOwner: "test", handlers });
  return { db, jobQueue, runner, chunkA };
}

const never = new AbortController().signal;

describe("job-queue-integration: contradiction workload (THE-562 #14)", () => {
  it("enqueues, runs via the durable queue, and flags the contradiction", async () => {
    const roles = rolesReturning('{"kind":"contradiction","rationale":"A negates B"}');
    const { db, jobQueue, runner, chunkA } = setup(roles);
    jobQueue.enqueue("contradiction", {
      class: "contradiction",
      payload: { vaultId: "v1", chunkId: chunkA.id },
      idempotencyKey: jobKey("v1", chunkA),
      maxAttempts: 3,
    });
    await runner.drainOnce(never);
    expect(jobQueue.stats().complete).toBe(1);
    const row = db.prepare("SELECT judge_verdict, status FROM contradictions").get() as {
      judge_verdict: string;
      status: string;
    };
    expect(row.judge_verdict).toBe("contradiction");
    expect(row.status).toBe("open");
  });

  it("dedups a rapid re-enqueue of IDENTICAL content into ONE job (idempotency)", () => {
    const roles = rolesReturning('{"kind":"no_conflict","rationale":"fine"}');
    const { jobQueue, chunkA } = setup(roles);
    const first = jobQueue.enqueue("contradiction", {
      class: "contradiction",
      payload: { vaultId: "v1", chunkId: chunkA.id },
      idempotencyKey: jobKey("v1", chunkA),
      maxAttempts: 3,
    });
    const second = jobQueue.enqueue("contradiction", {
      class: "contradiction",
      payload: { vaultId: "v1", chunkId: chunkA.id },
      idempotencyKey: jobKey("v1", chunkA),
      maxAttempts: 3,
    });
    expect(second.id).toBe(first.id);
    expect(jobQueue.stats().queued).toBe(1);
  });

  it("re-judges an edited chunk: same id + different content is a SECOND job, even after the first completed", async () => {
    // The bug this guards: chunk.id alone is content-independent (chunkId(vaultId, path, index)),
    // and enqueue()'s dedup matches a COMPLETE job's row too (jobs are never pruned). Keying only
    // on id would mean: index -> job completes -> edit the note (same id, new content) -> the
    // indexer deletes the old contradiction flags on re-embed -> enqueue() finds the completed
    // row for that id and enqueues NOTHING -> the edited chunk is never re-judged, and its flags
    // are gone for good. Folding the content hash into the key must prevent that.
    const roles = rolesReturning('{"kind":"no_conflict","rationale":"fine"}');
    const { jobQueue, runner, chunkA } = setup(roles);
    const original = jobQueue.enqueue("contradiction", {
      class: "contradiction",
      payload: { vaultId: "v1", chunkId: chunkA.id },
      idempotencyKey: jobKey("v1", chunkA),
      maxAttempts: 3,
    });
    await runner.drainOnce(never); // the first job runs to completion
    expect(jobQueue.stats().complete).toBe(1);

    const edited: IndexedChunk = { ...chunkA, content: "alpha, but edited" };
    const second = jobQueue.enqueue("contradiction", {
      class: "contradiction",
      payload: { vaultId: "v1", chunk: edited },
      idempotencyKey: jobKey("v1", edited),
      maxAttempts: 3,
    });
    expect(second.id).not.toBe(original.id); // a NEW job, not the stale completed one
    expect(jobQueue.stats().queued).toBe(1);
    expect(jobQueue.stats().complete).toBe(1); // the original job is untouched
  });

  it("retries a judge failure and dead-letters at attempt 3 (maxAttempts)", async () => {
    // checkContradictions is deliberately resilient to a per-pair judge failure — it degrades that
    // pair to `no_conflict` internally (see plane/jobs/contradiction.ts) rather than rejecting, so
    // one flaky judge call never sinks a whole batch. That means a handler which only ever calls
    // checkContradictions can never observe a judge throw. To still verify the QUEUE's retry ->
    // dead-letter mechanics for the "contradiction" job type end-to-end, this handler calls
    // `roles.judge` directly (as checkContradictions itself does, one layer in) and — unlike
    // checkContradictions — lets the failure propagate, modeling any handler-level failure mode
    // (a judge outage, a DB write error) that the runner must still retry and eventually dead-letter.
    const throwingRoles: GatewayRoles = {
      extract: async () => ({ text: "", model: "mock" }),
      synthesize: async () => ({ text: "", model: "mock" }),
      judge: async () => {
        throw new Error("judge unavailable");
      },
    };
    const { db, chunkA } = setup(throwingRoles);
    // A fresh JobQueue over the SAME db, whose clock we control directly, so the test can advance
    // past each retry's backoff window without depending on wall-clock time.
    const clock = { t: 1000 };
    const queue = new JobQueue(db, { now: () => clock.t });
    queue.enqueue("contradiction", {
      class: "contradiction",
      payload: { vaultId: "v1", chunkId: chunkA.id },
      idempotencyKey: jobKey("v1", chunkA),
      maxAttempts: 3,
    });
    const handlers = new Map<string, JobHandler>([
      [
        "contradiction",
        async (job) => {
          const { chunk } = job.payload as { vaultId: string; chunk: IndexedChunk };
          await throwingRoles.judge(prompt("judge", chunk.content));
        },
      ],
    ]);
    const controlledRunner = makeJobRunner({ queue, leaseOwner: "test", handlers });
    await controlledRunner.drainOnce(never); // attempt 1 -> retrying
    expect(queue.stats().retrying).toBe(1);
    clock.t += 10 * 60_000; // past backoff so attempt 2 is due
    await controlledRunner.drainOnce(never); // attempt 2 -> retrying
    expect(queue.stats().retrying).toBe(1);
    clock.t += 20 * 60_000; // past backoff so attempt 3 is due
    await controlledRunner.drainOnce(never); // attempt 3 (== maxAttempts) -> dead-letter
    expect(queue.stats().failed).toBe(1);
    expect(queue.stats().retrying).toBe(0);
  });

  it("#14: replaceIfTerminal re-judges past a dead-lettered row for the same content key", async () => {
    // The bug this guards: a dead-lettered ("failed") row for a content-keyed job is never
    // pruned, so without replaceIfTerminal a later enqueue of the SAME key (identical content
    // recurring, e.g. after a revert) would dedup against that failed row forever -- the chunk
    // can never be re-judged, permanently. cli.ts's makeOnIndexed hook sets replaceIfTerminal:
    // true for exactly this reason.
    const db = openMemoryDb();
    runMigrations(db, CACHE_MIGRATIONS);
    addChunk(db, "a", "A.md", [1, 0, 0]);
    addChunk(db, "b", "B.md", [0.95, 0.312, 0]); // cosine ~0.95 with A -> in [0.85, 0.99)
    const jobQueue = new JobQueue(db, { now: () => 1000 });
    const chunkA: IndexedChunk = { id: "a", path: "A.md", content: "alpha", embedding: [1, 0, 0] };
    const key = jobKey("v1", chunkA);

    // First job: a handler that always throws (models e.g. a judge-gateway outage). With
    // maxAttempts: 1 the runner dead-letters it on the very first failure -> a `failed` row for
    // this exact idempotency key.
    jobQueue.enqueue("contradiction", {
      class: "contradiction",
      payload: { vaultId: "v1", chunkId: chunkA.id },
      idempotencyKey: key,
      maxAttempts: 1,
      replaceIfTerminal: true,
    });
    const throwingHandlers = new Map<string, JobHandler>([
      [
        "contradiction",
        async () => {
          throw new Error("judge unavailable");
        },
      ],
    ]);
    const failingRunner = makeJobRunner({
      queue: jobQueue,
      leaseOwner: "test",
      handlers: throwingHandlers,
    });
    await failingRunner.drainOnce(never);
    expect(jobQueue.stats().failed).toBe(1);

    // Re-enqueue the SAME key with replaceIfTerminal: true and a working handler. Without the
    // fix, this would return the SAME dead-lettered job (a no-op) and the chunk would never be
    // re-judged.
    const second = jobQueue.enqueue("contradiction", {
      class: "contradiction",
      payload: { vaultId: "v1", chunkId: chunkA.id },
      idempotencyKey: key,
      maxAttempts: 3,
      replaceIfTerminal: true,
    });
    expect(second.state).toBe("queued");
    expect(jobQueue.stats().queued).toBe(1);

    const roles = rolesReturning('{"kind":"contradiction","rationale":"A negates B"}');
    const workingHandlers = new Map<string, JobHandler>([
      [
        "contradiction",
        async (job) => {
          // THE-571: id-only payload, re-read at run time (mirrors production).
          const { vaultId, chunkId } = job.payload as { vaultId: string; chunkId: string };
          const chunk = loadChunkForContradiction(db, vaultId, chunkId);
          if (!chunk) return;
          await checkContradictions({ db, roles, now: () => 1000 }, vaultId, [chunk]);
        },
      ],
    ]);
    const workingRunner = makeJobRunner({
      queue: jobQueue,
      leaseOwner: "test",
      handlers: workingHandlers,
    });
    await workingRunner.drainOnce(never);
    expect(jobQueue.stats().complete).toBe(1);
    expect(jobQueue.stats().failed).toBe(0);
    const row = db.prepare("SELECT judge_verdict, status FROM contradictions").get() as {
      judge_verdict: string;
      status: string;
    };
    expect(row.judge_verdict).toBe("contradiction");
    expect(row.status).toBe("open");
  });
});

// The exact key construction cli.ts's plane-enqueue scheduler tick uses for the weekly synthesis
// job — kept as one helper so the dedup test exercises production's actual idempotency key, not a
// stand-in opaque string.
function synthesisKey(now: () => number): string {
  const iso = isoWeek(new Date(now()));
  return `synthesis:${iso.year}-${iso.week}`;
}

function rolesReturningSynthesis(text: string): GatewayRoles {
  const r = async () => ({ text, model: "mock" });
  return { extract: r, synthesize: async () => ({ text, model: "opus" }), judge: r };
}

function planeSetup(roles: GatewayRoles) {
  const db = openMemoryDb();
  runMigrations(db, CACHE_MIGRATIONS);
  // Two-vault chunk fixture (per synthesis-job.test.ts's "writes one synthesis per vault" case),
  // so the plane leg's assertion of "a syntheses row per vault" is meaningful, not a single-row
  // coincidence.
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES ('a', 'v1', 'A.md', '0', '[]', 'note one', 'h1', 1, 0, 1)",
  ).run();
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES ('b', 'v2', 'B.md', '0', '[]', 'note two', 'h2', 1, 0, 1)",
  ).run();
  const now = () => Date.UTC(2026, 5, 1);
  const jobQueue = new JobQueue(db, { now });
  // The exact handler cli.ts's `if (roles)` block registers for the "synthesis" job type: THROW
  // when runSynthesis reports ok:false (e.g. parseSynthesis rejecting a malformed LLM response),
  // since the runner's dead-letter/retry machinery only reacts to a throw, never a return value.
  const handlers = new Map<string, JobHandler>([
    [
      "synthesis",
      async () => {
        const r = await runSynthesis({ db, roles, now });
        if (!r.ok) throw new Error(`synthesis job failed: ${JSON.stringify(r.detail ?? {})}`);
      },
    ],
  ]);
  const runner = makeJobRunner({ queue: jobQueue, leaseOwner: "test", handlers });
  return { db, jobQueue, runner, now };
}

describe("job-queue-integration: plane workload (THE-562 #14)", () => {
  it("enqueues a synthesis job, runs it via the durable queue, and writes a syntheses row per vault", async () => {
    const synth =
      '{"patterns":[{"title":"t","summary":"s","evidence_paths":["A.md"],"contradiction_ids":[]}],"clusters":[{"label":"l","summary":"s","chunk_paths":["A.md"]}]}';
    const { db, jobQueue, runner, now } = planeSetup(rolesReturningSynthesis(synth));
    jobQueue.enqueue("synthesis", {
      class: "plane",
      idempotencyKey: synthesisKey(now),
      maxAttempts: 1,
    });
    await runner.drainOnce(never);
    expect(jobQueue.stats().complete).toBe(1);
    const vaults = (
      db.prepare("SELECT vault_id FROM syntheses ORDER BY vault_id").all() as {
        vault_id: string;
      }[]
    ).map((r) => r.vault_id);
    expect(vaults).toEqual(["v1", "v2"]);
  });

  it("dead-letters on a REAL runSynthesis failure (unparseable LLM JSON), not just a synthetic throw", async () => {
    // The bug this guards: runSynthesis reports failure via `{ok:false, detail}` (parseSynthesis
    // throws on a malformed synthesize response, caught inside runSynthesis and turned into a
    // normal return — see plane/jobs/synthesis.ts), NOT by throwing out of runSynthesis itself. A
    // handler that awaits runSynthesis and discards the result would see the promise resolve
    // cleanly and the runner would mark the job `complete` — a real failure silently reported as
    // success, worse than the pre-migration in-process plane (which at least logged to stderr).
    // The production handler (mirrored in planeSetup above) must inspect `.ok` and throw.
    const { jobQueue, runner, now } = planeSetup(rolesReturningSynthesis("not valid json at all"));
    jobQueue.enqueue("synthesis", {
      class: "plane",
      idempotencyKey: synthesisKey(now),
      maxAttempts: 1,
    });
    await runner.drainOnce(never);
    expect(jobQueue.stats().failed).toBe(1);
    expect(jobQueue.stats().complete).toBe(0);
    expect(jobQueue.stats().retrying).toBe(0);
  });

  it("dedups a repeat weekly enqueue with the same synthesis:<isoWeek> key into ONE job", () => {
    const { jobQueue, now } = planeSetup(rolesReturningSynthesis("{}"));
    const first = jobQueue.enqueue("synthesis", {
      class: "plane",
      idempotencyKey: synthesisKey(now),
      maxAttempts: 1,
    });
    const second = jobQueue.enqueue("synthesis", {
      class: "plane",
      idempotencyKey: synthesisKey(now),
      maxAttempts: 1,
    });
    expect(second.id).toBe(first.id);
    expect(jobQueue.stats().queued).toBe(1);
  });

  it("dead-letters a plane job on its FIRST failure (maxAttempts: 1) instead of retrying", async () => {
    // Synthesis/audit regenerate next cycle, so a transient failure should not retry — it should
    // dead-letter immediately, unlike the contradiction workload's maxAttempts: 3. Mirrors the
    // contradiction suite's "retries a judge failure" case: a handler that throws directly models
    // any handler-level failure (gateway outage, DB write error) the runner must dead-letter.
    const db = openMemoryDb();
    runMigrations(db, CACHE_MIGRATIONS);
    const now = () => Date.UTC(2026, 5, 1);
    const jobQueue = new JobQueue(db, { now });
    jobQueue.enqueue("synthesis", {
      class: "plane",
      idempotencyKey: synthesisKey(now),
      maxAttempts: 1,
    });
    const handlers = new Map<string, JobHandler>([
      [
        "synthesis",
        async () => {
          throw new Error("gateway unavailable");
        },
      ],
    ]);
    const runner = makeJobRunner({ queue: jobQueue, leaseOwner: "test", handlers });
    await runner.drainOnce(never);
    expect(jobQueue.stats().failed).toBe(1);
    expect(jobQueue.stats().retrying).toBe(0);
  });
});

// THE-571: the contradiction payload used to serialize the WHOLE chunk, embedding included, into
// jobs.payload — a dense vector JSON-encoded per enqueue, on a table that (before this ticket) was
// never pruned. It now carries only { vaultId, chunkId } and the handler re-reads the chunk.
//
// That is not merely smaller. Re-reading at RUN time means the judge sees the chunk as it is now,
// not as it was at enqueue; and a chunk deleted between the two must SKIP rather than throw, since
// throwing is how the runner dead-letters, and a deleted chunk is a normal race, not a failure.
describe("THE-571 contradiction payload is id-only", () => {
  it("loads a chunk by id with its embedding", () => {
    const { db } = setup(null);
    const chunk = loadChunkForContradiction(db, "v1", "a");
    expect(chunk).not.toBeNull();
    expect(chunk?.id).toBe("a");
    expect(chunk?.embedding.length).toBeGreaterThan(0);
    expect(chunk?.content.length).toBeGreaterThan(0);
  });

  it("returns null for a chunk that no longer exists (deleted between enqueue and run)", () => {
    const { db } = setup(null);
    expect(loadChunkForContradiction(db, "v1", "gone")).toBeNull();
  });

  it("scopes by vault — another vault's chunk id does not resolve", () => {
    const { db } = setup(null);
    expect(loadChunkForContradiction(db, "other-vault", "a")).toBeNull();
  });
});
