import { stat } from "node:fs/promises";
import type { GitSync } from "./sync";

export interface GitSyncTimings {
  tickMs: number;
  quietMs: number;
  capMs: number;
  triggerPollMs: number;
}

export const DEFAULT_GIT_SYNC_TIMINGS: GitSyncTimings = {
  tickMs: 2_000,
  quietMs: 10_000,
  capMs: 60_000,
  triggerPollMs: 1_000,
};

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

async function triggerMtime(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

export async function runGitSyncLoop(
  sync: GitSync,
  signal: AbortSignal,
  timings: GitSyncTimings,
): Promise<void> {
  let nextPull = Date.now() + sync.config.pullIntervalMs;
  let nextTick = Date.now() + timings.tickMs;
  let nextTriggerPoll = Date.now() + timings.triggerPollMs;
  let seenTrigger = await triggerMtime(`${sync.config.stateDir}/trigger`);
  let firstDirtyAt: number | undefined;
  let changedAt: number | undefined;
  let fingerprint = "";

  while (!signal.aborted) {
    const now = Date.now();
    const delay = Math.max(0, Math.min(nextPull, nextTick, nextTriggerPoll) - now);
    await wait(delay, signal);
    if (signal.aborted) break;
    const current = Date.now();
    let pullPending = current >= nextPull;

    if (current >= nextTriggerPoll) {
      nextTriggerPoll = current + timings.triggerPollMs;
      const observed = await triggerMtime(`${sync.config.stateDir}/trigger`);
      if (observed !== seenTrigger) {
        seenTrigger = observed;
        pullPending = true;
      }
    }

    if (current >= nextTick) {
      nextTick = current + timings.tickMs;
      if (sync.config.push === "batched") {
        try {
          const snapshot = await sync.dirtySnapshot();
          // Stamp after the snapshot: a write can land while the status is in flight, and a
          // stamp taken before the await would place the change earlier than the write.
          const observedAt = Date.now();
          if (!snapshot.dirty) {
            firstDirtyAt = undefined;
            changedAt = undefined;
            fingerprint = "";
          } else if (firstDirtyAt === undefined) {
            firstDirtyAt = observedAt;
            changedAt = observedAt;
            fingerprint = snapshot.fingerprint;
          } else {
            if (snapshot.fingerprint !== fingerprint) {
              fingerprint = snapshot.fingerprint;
              changedAt = observedAt;
            }
            const quiet = observedAt - (changedAt ?? observedAt) >= timings.quietMs;
            const capped = observedAt - firstDirtyAt >= timings.capMs;
            if (quiet || capped) {
              await sync.commitDirty();
              firstDirtyAt = undefined;
              changedAt = undefined;
              fingerprint = "";
            }
          }
        } catch {
          nextTick = current + Math.max(timings.tickMs, 250);
          firstDirtyAt = undefined;
          changedAt = undefined;
          fingerprint = "";
        }
      }
    }

    if (pullPending) {
      nextPull = current + sync.config.pullIntervalMs;
      try {
        await sync.syncOnce();
      } catch {
        // syncOnce has already persisted and logged the error. A sidecar keeps retrying.
      }
      firstDirtyAt = undefined;
      changedAt = undefined;
      fingerprint = "";
    }
  }
}
