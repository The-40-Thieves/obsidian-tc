// Sleep-time consolidation plane — THE-233 W-WORKERS. A local job registry + runner that
// collapses the retired Cloudflare workers (kb-synthesis, kb-audit) and the contradiction
// detector into in-process jobs. These are LOCAL jobs invoked programmatically, NOT crons:
// the scheduling trigger (a server-lifecycle timer / session-close hook) is wired in the
// integration slice. Each run is recorded to job_runs when that table exists.

import { tableExists } from "../db/introspect";
import type { Database } from "../db/types";
import type { JobHandler } from "../scheduler/job-runner";
import { errorMessage } from "../util/errors";
import type { GatewayRoles } from "./gateway";

export interface JobContext {
  /** THE-462(b): set by the scheduler; when aborted, runAll stops before the next job. */
  signal?: AbortSignal;
  db: Database;
  /** Generative seam; null disables generative jobs (they degrade rather than throw). */
  roles: GatewayRoles | null;
  now: () => number;
  log?: (msg: string) => void;
  /** Aggregate character cap on a generative job's whole request (system + user). Absent -> the
   *  job's own conservative default. Exists because the model behind a gateway ROLE is swappable
   *  at the gateway, so this side cannot know the context window. */
  maxPromptChars?: number | undefined;
}

export interface JobResult {
  ok: boolean;
  detail?: Record<string, unknown>;
}

export interface Job {
  name: string;
  run(ctx: JobContext): Promise<JobResult>;
}

/** The minimum a run needs to be recorded. JobContext satisfies it structurally, so the
 *  SleepTimePlane path below passes its ctx unchanged. */
export interface RunRecorder {
  db: Database;
  now: () => number;
}

// THE-625 item 3: cli.ts's synthesis/audit/note-quality job-queue handlers were 3-line ok:false-
// must-throw twins — a plane job reports failure via JobResult.ok:false, but the durable runner's
// dead-letter/retry only reacts to a THROW, so that boolean has to become one somewhere.
//
// THE-716: it also has to RECORD somewhere, and until now it did not. `SleepTimePlane.runJob`
// records every run and production never calls it — moving these jobs onto the durable queue left
// the recorder on the path nothing uses, so job_runs sat at zero rows for the life of the
// deployment while `derived.liveness` correctly reported it `silent`.
//
// `rec` is REQUIRED rather than optional on purpose. An optional recorder is how this recurs: a
// future call site omits it, the job runs, nothing records, and the table looks exactly as healthy
// as it did before. The type system now refuses to wire a plane job that cannot be observed.
export function wrapPlaneJob(
  name: string,
  run: () => Promise<JobResult>,
  rec: RunRecorder,
): JobHandler {
  return async () => {
    const startedAt = rec.now();
    let r: JobResult;
    try {
      r = await run();
    } catch (e) {
      // A thrown job is still a run, and it is the one you most want in the log. Recorded BEFORE
      // the rethrow — after it, this line never executes.
      recordRun(rec, name, startedAt, { ok: false, detail: { error: errorMessage(e) } });
      throw e;
    }
    recordRun(rec, name, startedAt, r);
    // Order matters for the same reason: the ok:false -> throw conversion below is what the
    // durable runner reacts to, so the row has to be written first or a FAILING job — the case
    // job_runs exists to answer questions about — would never appear in it.
    if (!r.ok) throw new Error(`${name} job failed: ${JSON.stringify(r.detail ?? {})}`);
  };
}

export class SleepTimePlane {
  private readonly jobs = new Map<string, Job>();

  register(job: Job): this {
    this.jobs.set(job.name, job);
    return this;
  }

  list(): string[] {
    return [...this.jobs.keys()];
  }

  async runJob(name: string, ctx: JobContext): Promise<JobResult> {
    const job = this.jobs.get(name);
    if (!job) throw new Error(`sleep-time plane: unknown job '${name}'`);
    const startedAt = ctx.now();
    let result: JobResult;
    try {
      result = await job.run(ctx);
    } catch (e) {
      result = { ok: false, detail: { error: errorMessage(e) } };
    }
    recordRun(ctx, name, startedAt, result);
    return result;
  }

  async runAll(ctx: JobContext): Promise<Record<string, JobResult>> {
    const out: Record<string, JobResult> = {};
    for (const name of this.jobs.keys()) {
      // THE-462(b): shutdown cancels the REMAINING jobs. Checked between jobs rather than mid-job
      // so a job is never torn down half-written — each one either runs fully or not at all.
      if (ctx.signal?.aborted) break;
      out[name] = await this.runJob(name, ctx);
    }
    return out;
  }
}

function recordRun(ctx: RunRecorder, job: string, startedAt: number, result: JobResult): void {
  if (!tableExists(ctx.db, "job_runs")) return;
  try {
    ctx.db
      .prepare(
        "INSERT INTO job_runs (job, started_at, finished_at, ok, detail) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        job,
        startedAt,
        ctx.now(),
        result.ok ? 1 : 0,
        result.detail ? JSON.stringify(result.detail) : null,
      );
  } catch {
    /* job_runs logging is best-effort and never fails a job */
  }
}
