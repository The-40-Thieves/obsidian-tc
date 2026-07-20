// THE-457/THE-458 (audit #6): the continuous, single-flight, bounded contradiction drain, extracted
// from the cli composition root so its concurrency semantics are unit-testable.
//
// The in-flight batch is represented as a PROMISE, not a boolean. A concurrent caller (notably
// graceful shutdown) joins the SAME running promise and can AWAIT it, so the DB is never closed under
// an in-flight checkContradictions write. A boolean guard let shutdown's drain call return immediately
// while a batch was still writing — the race this closes.

import type { Database } from "../../db/types";
import { checkContradictions, groupContradictionQueue, type IndexedChunk } from "./contradiction";
import type { GatewayRoles } from "../gateway";

export interface ContradictionDrainDeps {
  db: Database;
  /** null disables draining entirely (generative gateway absent). */
  roles: GatewayRoles | null;
  /** The shared enqueue buffer; drained in place (splice). */
  queue: Array<{ vaultId: string; chunk: IndexedChunk }>;
  /** Max chunks processed per bounded batch. */
  batchSize: number;
  now?: () => number;
  /** Reported for a checkContradictions failure; the drain never rejects. */
  onError?(err: unknown): void;
  /** Batch processor seam (defaults to checkContradictions); injected in tests. */
  check?: typeof checkContradictions;
}

export interface ContradictionDrainer {
  /** Drain ONE bounded batch. Single-flight: a call made while a batch is in-flight returns that same
   *  in-flight promise instead of starting (or racing) a second batch. Resolves when the batch's
   *  writes are durable. */
  drainOnce(): Promise<void>;
  /** Drain the queue to empty via the bounded worker (used by the boot sweep). */
  drainToEmpty(): Promise<void>;
  /** The in-flight batch promise, or null when idle. Await this before closing the DB at shutdown. */
  readonly inFlight: Promise<void> | null;
}

export function makeContradictionDrainer(deps: ContradictionDrainDeps): ContradictionDrainer {
  const now = deps.now ?? Date.now;
  const check = deps.check ?? checkContradictions;
  let activeDrain: Promise<void> | null = null;

  const drainOnce = (): Promise<void> => {
    const roles = deps.roles;
    if (!roles) return Promise.resolve();
    if (activeDrain) return activeDrain; // single-flight: join the in-flight batch, don't race it
    if (deps.queue.length === 0) return Promise.resolve();
    const run = (async () => {
      try {
        const batch = deps.queue.splice(0, deps.batchSize);
        for (const [vaultId, chunks] of groupContradictionQueue(batch)) {
          await check({ db: deps.db, roles, now }, vaultId, chunks).catch((e) => deps.onError?.(e));
        }
      } finally {
        activeDrain = null;
      }
    })();
    activeDrain = run;
    return run;
  };

  const drainToEmpty = async (): Promise<void> => {
    // Without a gateway drainOnce is a no-op, so it would never clear the queue — bail before looping.
    if (!deps.roles) return;
    // Loop the bounded worker: each pass drains one batch (or joins an in-flight one). Terminates when
    // the queue is empty AND nothing is in flight.
    while (activeDrain || deps.queue.length > 0) await drainOnce();
  };

  return {
    drainOnce,
    drainToEmpty,
    get inFlight(): Promise<void> | null {
      return activeDrain;
    },
  };
}
