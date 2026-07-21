// Sleep-time consolidation plane — THE-233 W-WORKERS. A local job registry + runner that
// collapses the retired Cloudflare workers (kb-synthesis, kb-audit) and the contradiction
// detector into in-process jobs. These are LOCAL jobs invoked programmatically, NOT crons:
// the scheduling trigger (a server-lifecycle timer / session-close hook) is wired in the
// integration slice. Each run is recorded to job_runs when that table exists.

import { tableExists } from "../db/introspect";
import type { Database } from "../db/types";
import { Scheduler } from "../scheduler/scheduler";
import type { GatewayRoles } from "./gateway";

export interface JobContext {
  db: Database;
  /** Generative seam; null disables generative jobs (they degrade rather than throw). */
  roles: GatewayRoles | null;
  now: () => number;
  log?: (msg: string) => void;
}

export interface JobResult {
  ok: boolean;
  detail?: Record<string, unknown>;
}

export interface Job {
  name: string;
  run(ctx: JobContext): Promise<JobResult>;
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
      result = { ok: false, detail: { error: (e as Error).message } };
    }
    recordRun(ctx, name, startedAt, result);
    return result;
  }

  async runAll(ctx: JobContext): Promise<Record<string, JobResult>> {
    const out: Record<string, JobResult> = {};
    for (const name of this.jobs.keys()) {
      out[name] = await this.runJob(name, ctx);
    }
    return out;
  }
}

export interface PlaneSchedulerDeps {
  db: Database;
  roles: GatewayRoles | null;
  intervalMs: number;
  now?: () => number;
  onRun?: (results: Record<string, JobResult>) => void;
  onError?: (e: unknown) => void;
  /** THE-457: called when a tick is skipped because the previous runAll is still in flight; the
   *  argument is the running count of skipped ticks (an operator signal that runs exceed the
   *  interval). */
  onSkip?: (skipped: number) => void;
}

/**
 * THE-296: the ambient scheduling trigger the integration slice reserved. Runs every registered
 * job on an unref'd interval (the timer never keeps the process alive; stdio EOF still exits);
 * failures route to onError and never escape. Callers gate on roles being configured — the
 * generative jobs degrade without them, but scheduling then is pure DB churn.
 */
export function startPlaneScheduler(plane: SleepTimePlane, deps: PlaneSchedulerDeps): () => void {
  const scheduler = new Scheduler();
  registerPlaneScheduler(scheduler, plane, deps);
  scheduler.start();
  return () => {
    void scheduler.stop();
  };
}

/**
 * THE-462: register plane consolidation as a job on a SHARED scheduler (the production path — one
 * timer for all background work). The run body (plane.runAll) is unchanged; the scheduler's
 * single-flight guard replaces the former inline running/skipped guard (THE-457) and drives the same
 * onSkip(skipped) signal — the plane's own idempotent job_runs recording is untouched. The scheduler
 * owns the unref'd timer; failures route to onError and never escape.
 */
export function registerPlaneScheduler(
  scheduler: Scheduler,
  plane: SleepTimePlane,
  deps: PlaneSchedulerDeps,
): void {
  scheduler.register({
    name: "plane-consolidation",
    intervalMs: deps.intervalMs,
    run: async () => {
      const results = await plane.runAll({
        db: deps.db,
        roles: deps.roles,
        now: deps.now ?? Date.now,
      });
      deps.onRun?.(results);
    },
    onSkip: (n) => deps.onSkip?.(n),
    onError: (e) => deps.onError?.(e),
  });
}

function recordRun(ctx: JobContext, job: string, startedAt: number, result: JobResult): void {
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
