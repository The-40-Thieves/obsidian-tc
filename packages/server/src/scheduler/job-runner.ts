// #14 (THE-562 / THE-517): the generic runner that finally wires the durable JobQueue to work.
// It owns NO durability — claim/lease/retry/dead-letter/cancel all live in the queue + runJob. It
// only claims due jobs and dispatches each to its type's handler, bounded per tick. Registered on
// the shared Scheduler (THE-462) as one single-flight job, so its lifecycle, backoff, and bounded
// shutdown come for free.
import { type Job, type JobQueue, type RunJobContext, runJob } from "./job-queue";

export type JobHandler = (job: Job, ctx: RunJobContext) => Promise<void>;

export interface JobRunnerDeps {
  queue: JobQueue;
  /** Stable per process (e.g. `serve:${pid}`) — the lease owner recorded on every claim. */
  leaseOwner: string;
  handlers: Map<string, JobHandler>;
  /** Max jobs processed per drainOnce (default 32). Bounds a single tick's work. */
  maxPerTick?: number;
  leaseMs?: number;
  /** Per-class RUNNING cap across ticks (JobQueue.claim classLimits). */
  classLimits?: Record<string, number>;
  onOutcome?: (type: string, outcome: "complete" | "retrying" | "failed" | "lease-lost") => void;
}

export function makeJobRunner(deps: JobRunnerDeps): {
  drainOnce: (signal: AbortSignal) => Promise<void>;
} {
  const maxPerTick = deps.maxPerTick ?? 32;
  const types = [...deps.handlers.keys()];

  return {
    async drainOnce(signal: AbortSignal): Promise<void> {
      // Guard against a zero-handler runner: JobQueue.claim only restricts to `types` when the
      // array is non-empty (`opts.types?.length`), so an empty array is indistinguishable from
      // "no filter" and would claim jobs of EVERY type, only to terminally dead-letter every one
      // of them below. Make a runner with no handlers a no-op instead of destructive claim-all.
      if (types.length === 0) return;
      for (let i = 0; i < maxPerTick; i++) {
        if (signal.aborted) return;
        const job = deps.queue.claim({
          leaseOwner: deps.leaseOwner,
          types,
          ...(deps.leaseMs !== undefined ? { leaseMs: deps.leaseMs } : {}),
          ...(deps.classLimits ? { classLimits: deps.classLimits } : {}),
        });
        if (!job) return; // queue drained (or every due class saturated) this tick
        const handler = deps.handlers.get(job.type);
        if (!handler) {
          // A queued type with no registered handler: fail it terminally rather than spin. This
          // only happens if a producer enqueues a type the runner was not configured for.
          deps.queue.fail(
            job.id,
            deps.leaseOwner,
            new Error(`no handler for job type ${job.type}`),
            {
              terminal: true,
            },
          );
          deps.onOutcome?.(job.type, "failed");
          continue;
        }
        const { outcome } = await runJob(deps.queue, job, deps.leaseOwner, handler);
        deps.onOutcome?.(job.type, outcome);
      }
    },
  };
}
