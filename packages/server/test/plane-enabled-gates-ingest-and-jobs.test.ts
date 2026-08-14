// THE-822 / GH #786 — `plane.enabled: false` stopped the SCHEDULED consolidation pass
// (registerPlaneSchedule already gated on `plane.enabled && roles`) but NOT the two other
// roles-only consumers: the per-index-write contradiction enqueue (createOnIndexedHook) and the
// contradiction/synthesis/audit job HANDLERS (wireJobHandlers). With any gateway configured, a
// disabled plane still enqueued and RAN unattended per-chunk LLM calls over the whole vault on
// every index write.
//
// Both functions must now gate the plane-scoped roles through a required `plane.enabled` dep,
// mirroring the precedent registerPlaneSchedule already set — while leaving the always-on
// task-call handler, the note-quality handler, and (elsewhere) wireDomainTools's ungated `roles`
// completely unaffected.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { TASK_CALL_JOB_TYPE } from "../src/mcp/tasks";
import { createOnIndexedHook, wireJobHandlers } from "../src/runtime/plane-wiring";
import { JobQueue } from "../src/scheduler/job-queue";
import { openMemoryDb } from "./helpers";

const JOBS = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260723_002_jobs.sql", import.meta.url)),
  "utf8",
);
const INIT = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);
const OWNER = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260728_001_jobs_owner.sql", import.meta.url)),
  "utf8",
);
const OUTCOME = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260728_002_jobs_outcome.sql", import.meta.url)),
  "utf8",
);

function jobsDb() {
  const db = openMemoryDb();
  runMigrations(db, [
    { version: "20260519_001", sql: INIT },
    { version: "20260723_002", sql: JOBS },
    { version: "20260728_001", sql: OWNER },
    { version: "20260728_002", sql: OUTCOME },
  ]);
  return db;
}

const ROLES = {
  extract: async () => ({ text: "", model: "m" }),
  synthesize: async () => ({ text: "", model: "m" }),
  judge: async () => ({ text: "", model: "m" }),
};

const CHUNK = { id: "c1", path: "note.md", content: "hello", embedding: [0] };

describe("THE-822: createOnIndexedHook honors plane.enabled, not just roles", () => {
  it("plane disabled + roles present -> no hook, and NOTHING is enqueued", () => {
    const db = jobsDb();
    const jobQueue = new JobQueue(db);
    const makeOnIndexed = createOnIndexedHook({
      jobQueue,
      roles: ROLES,
      plane: { enabled: false },
    });

    expect(makeOnIndexed("vault1")).toBeUndefined();

    const rows = db.prepare("SELECT * FROM jobs WHERE type = 'contradiction'").all();
    expect(rows).toHaveLength(0);
  });

  it("plane enabled + roles present -> hook enqueues a contradiction job (no regression)", () => {
    const db = jobsDb();
    const jobQueue = new JobQueue(db);
    const makeOnIndexed = createOnIndexedHook({ jobQueue, roles: ROLES, plane: { enabled: true } });

    const hook = makeOnIndexed("vault1");
    expect(hook).toBeDefined();
    hook?.([CHUNK]);

    const rows = db.prepare("SELECT * FROM jobs WHERE type = 'contradiction'").all();
    expect(rows).toHaveLength(1);
  });

  it("roles null -> no hook regardless of plane.enabled", () => {
    const db = jobsDb();
    const jobQueue = new JobQueue(db);
    expect(
      createOnIndexedHook({ jobQueue, roles: null, plane: { enabled: true } })("vault1"),
    ).toBeUndefined();
    expect(
      createOnIndexedHook({ jobQueue, roles: null, plane: { enabled: false } })("vault1"),
    ).toBeUndefined();
  });
});

/** Deps wireJobHandlers never reads before deciding whether to register a given handler. Cast
 *  rather than constructed, matching citation-job-registration.test.ts's stub idiom: building a
 *  real registry/acl/queue here would test those, not the gate. */
const stub = <T>(): T => ({}) as T;

function handlersWith(over: Record<string, unknown>): Set<string> {
  const { jobHandlers } = wireJobHandlers({
    registry: stub(),
    db: stub(),
    acl: stub(),
    jobQueue: stub(),
    roles: null,
    plane: { enabled: true },
    embeddingProvider: stub(),
    experientialOpen: false,
    experientialDb: stub(),
    vaults: [],
    ...over,
  } as never);
  return new Set(jobHandlers.keys());
}

describe("THE-822: wireJobHandlers honors plane.enabled, not just roles", () => {
  it("plane disabled + roles present -> contradiction/synthesis/audit do NOT register", () => {
    const handlers = handlersWith({ roles: ROLES, plane: { enabled: false } });
    expect(handlers.has("contradiction")).toBe(false);
    expect(handlers.has("synthesis")).toBe(false);
    expect(handlers.has("audit")).toBe(false);
  });

  it("plane disabled + roles present -> task-call STILL registers (always-on)", () => {
    const handlers = handlersWith({ roles: ROLES, plane: { enabled: false } });
    expect(handlers.has(TASK_CALL_JOB_TYPE)).toBe(true);
  });

  it("plane disabled + roles present -> note-quality still registers on its own condition", () => {
    const handlers = handlersWith({
      roles: ROLES,
      plane: { enabled: false },
      experientialOpen: true,
      experientialDb: stub(),
    });
    expect(handlers.has("note-quality")).toBe(true);
  });

  it("plane enabled + roles present -> contradiction/synthesis/audit register (no regression)", () => {
    const handlers = handlersWith({ roles: ROLES, plane: { enabled: true } });
    expect(handlers.has("contradiction")).toBe(true);
    expect(handlers.has("synthesis")).toBe(true);
    expect(handlers.has("audit")).toBe(true);
    expect(handlers.has(TASK_CALL_JOB_TYPE)).toBe(true);
  });

  it("roles null -> nothing plane-related registers, regardless of plane.enabled", () => {
    expect(handlersWith({ roles: null, plane: { enabled: true } }).has("contradiction")).toBe(
      false,
    );
    expect(handlersWith({ roles: null, plane: { enabled: true } }).has("synthesis")).toBe(false);
    expect(handlersWith({ roles: null, plane: { enabled: true } }).has("audit")).toBe(false);
    expect(handlersWith({ roles: null, plane: { enabled: false } }).has("contradiction")).toBe(
      false,
    );
    expect(handlersWith({ roles: null, plane: { enabled: false } }).has("synthesis")).toBe(false);
    expect(handlersWith({ roles: null, plane: { enabled: false } }).has("audit")).toBe(false);
  });
});
