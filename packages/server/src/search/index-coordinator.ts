// THE-455: per-(vault,path) index-on-write coordinator.
//
// The write hooks were fire-and-forget (`void indexNote(...)` / `deindexNote(...)`), so two rapid
// writes to the SAME note could embed concurrently and COMMIT OUT OF ORDER — a slow older write
// landing after a fast newer one leaves a stale index — and a delete could be resurrected by an
// older in-flight write. Boot reconcile eventually repaired it, but until then semantic + graph
// retrieval could return stale or deleted content.
//
// This serializes operations per (vault,path): different paths still run concurrently, but the same
// path runs strictly one-at-a-time, so the newest mutation always commits last and wins. Queued
// mutations for a path are COALESCED to the latest desired state, so a burst of editor autosaves
// embeds once, not N times. Strict per-key serialization removes the overlap that made stale commits
// possible, so no generation/hash bookkeeping is needed.
//
// THE-458 (audit #5): distinct paths ran with NO ceiling, so a bulk mutation could fan out an
// unbounded number of concurrent indexNote/embedding calls. A global + per-vault concurrency
// semaphore now bounds how many paths run their handler at once (per-key ordering/coalescing is
// unchanged), plus a queue-depth stats() snapshot and an edge-triggered backpressure signal.

export type IndexOp = { kind: "write"; content: string } | { kind: "delete" };

export interface IndexCoordinatorHandlers {
  /** Apply a (re)index for a path. Resolves when the index commit is durable. */
  write(vaultId: string, path: string, content: string): Promise<unknown> | unknown;
  /** Remove a path from the index. Resolves when the deindex commit is durable. */
  delete(vaultId: string, path: string): Promise<unknown> | unknown;
  /** Reported for a handler that threw; the coordinator never rejects to the caller. */
  onError?(err: unknown, vaultId: string, path: string): void;
}

/** THE-458 (audit #5): concurrency + backpressure knobs. Per-key ordering/coalescing is unchanged;
 *  these bound how many distinct paths run their (embedding-bearing) handler at once. */
export interface IndexCoordinatorOptions {
  /** Max drains running a handler concurrently across ALL vaults. Default 8. */
  globalConcurrency?: number;
  /** Max drains running a handler concurrently for a SINGLE vault. Default 4 (audit: 2–4). */
  perVaultConcurrency?: number;
  /** Soft cap on distinct pending keys. Exceeding it fires onBackpressure — writes are NEVER dropped
   *  (a dropped index write would strand stale content), so this is an operator signal, not a limiter. */
  queueMax?: number;
  /** Best-effort callback on the rising edge of the pending-key depth crossing queueMax. */
  onBackpressure?(depth: number): void;
}

/** A snapshot of the coordinator's live depth for health/metrics (audit #5: queue-depth visibility). */
export interface IndexCoordinatorStats {
  /** Distinct keys with a coalesced op queued or in-flight. */
  queued: number;
  /** Drains currently executing a handler (holding a global slot). */
  active: number;
  /** Whether the pending-key depth is currently over queueMax. */
  backpressured: boolean;
  /** Per-vault active-drain counts (only vaults with >0 active are listed). */
  perVaultActive: Record<string, number>;
  /** THE-585 (#2): cumulative writes avoided by coalescing — a pending op replaced by a newer one
   *  for the same (vault, path) before it ran. Monotonic for the process's lifetime. */
  coalesced: number;
}

/** A fair FIFO counting semaphore. release() hands a permit directly to the head waiter (no wakeup
 *  race), so acquisition order matches arrival order. */
class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];
  constructor(permits: number) {
    this.permits = permits;
  }
  acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.permits += 1;
  }
}

export class IndexCoordinator {
  // Latest desired state per key (coalescing target); cleared when a drain claims it.
  private readonly latest = new Map<string, IndexOp>();
  // Serialization chain per key; a key's next op awaits its previous op.
  private readonly chain = new Map<string, Promise<void>>();
  private readonly globalSem: Semaphore;
  private readonly perVaultConcurrency: number;
  private readonly vaultSems = new Map<string, Semaphore>();
  private readonly vaultActive = new Map<string, number>();
  private readonly queueMax: number;
  private readonly onBackpressure?: (depth: number) => void;
  private active = 0;
  /** THE-585 (#2): cumulative count of pending ops superseded before they ran. */
  private coalesced = 0;
  private overQueueMax = false;

  constructor(
    private readonly handlers: IndexCoordinatorHandlers,
    options: IndexCoordinatorOptions = {},
  ) {
    this.globalSem = new Semaphore(Math.max(1, options.globalConcurrency ?? 8));
    this.perVaultConcurrency = Math.max(1, options.perVaultConcurrency ?? 4);
    this.queueMax = Math.max(1, options.queueMax ?? 1000);
    this.onBackpressure = options.onBackpressure;
  }

  private key(vaultId: string, path: string): string {
    // NUL delimiter: vault ids and paths can contain most characters but never a NUL byte. A
    // PRINTABLE separator would be unsafe -- both vault ids and note paths routinely contain
    // spaces, so ("A", "B note.md") and ("A B", "note.md") would collide on one key. A collision
    // shares BOTH the `latest` coalescing slot and the `chain` serialization chain, and because
    // drain() claims latest.get(k) but calls the handler with its OWN vaultId/path, one pair's
    // content would commit under the other pair's path -- silent cross-vault corruption.
    // Covered by the "never collide" regression test below.
    //
    // Write the ESCAPE, never a literal NUL byte: a raw byte makes this file binary to git and
    // grep, so its diffs stop being reviewable and grep-based guards silently skip it. That is
    // how #378 came to be reported as a space delimiter. Enforced by scripts/check-nul-bytes.mjs.
    return `${vaultId}\u0000${path}`;
  }

  private vaultSem(vaultId: string): Semaphore {
    let s = this.vaultSems.get(vaultId);
    if (s === undefined) {
      s = new Semaphore(this.perVaultConcurrency);
      this.vaultSems.set(vaultId, s);
    }
    return s;
  }

  /** Queue a (re)index of `path`. Fire-and-forget: returns immediately; ordering is guaranteed. */
  submitWrite(vaultId: string, path: string, content: string): void {
    this.enqueue(vaultId, path, { kind: "write", content });
  }

  /** Queue a deindex of `path`. Serialized with writes for the same path (no resurrection). */
  submitDelete(vaultId: string, path: string): void {
    this.enqueue(vaultId, path, { kind: "delete" });
  }

  private enqueue(vaultId: string, path: string, op: IndexOp): void {
    const k = this.key(vaultId, path);
    // THE-585 (#2): a pending op being REPLACED is a write this process will never perform — the
    // coalescing THE-455 exists to do. Counted here, at the only place it happens, rather than
    // inferred from a difference between two other counters. Like the dedup counter, a RISE IS
    // GOOD (work avoided); a fall to zero under a bursty writer means coalescing stopped working.
    if (this.latest.has(k)) this.coalesced += 1;
    this.latest.set(k, op); // coalesce: the newest desired state wins
    const prev = this.chain.get(k) ?? Promise.resolve();
    const next = prev.then(() => this.drain(vaultId, path, k));
    this.chain.set(k, next);
    // Drop the chain entry once it settles, unless a newer submit already replaced it — keeps the
    // map from growing unbounded over a long-lived process without dropping in-flight work.
    void next.finally(() => {
      if (this.chain.get(k) === next) this.chain.delete(k);
    });
    // Backpressure signal (audit #5): distinct pending keys crossed the soft cap. Edge-triggered off
    // the per-submit transition, so a sustained overload fires once (not once per submit); writes are
    // still enqueued (never dropped). stats().backpressured reflects the LIVE depth, not this flag.
    const nowOver = this.chain.size > this.queueMax;
    if (nowOver && !this.overQueueMax) {
      try {
        this.onBackpressure?.(this.chain.size);
      } catch {
        /* an observability sink must never break the write path */
      }
    }
    this.overQueueMax = nowOver;
  }

  private async drain(vaultId: string, path: string, k: string): Promise<void> {
    // Claim the coalesced op SYNCHRONOUSLY (before any await), so a drain's target is locked in the
    // moment its chain turn arrives — identical to the pre-concurrency timing. A newer submit re-adds
    // latest AND chains its own drain, which runs strictly after this one (per-key serialization).
    const op = this.latest.get(k);
    if (op === undefined) return; // an earlier chained drain already applied the coalesced state
    this.latest.delete(k);
    // Gate only the HANDLER execution: acquire per-vault THEN global (consistent order across all
    // drains -> no deadlock). Holding the vault slot while waiting for a global slot only blocks
    // same-vault drains, which are already capped, so it cannot starve other vaults.
    const vaultSem = this.vaultSem(vaultId);
    await vaultSem.acquire();
    await this.globalSem.acquire();
    this.active += 1;
    this.vaultActive.set(vaultId, (this.vaultActive.get(vaultId) ?? 0) + 1);
    try {
      if (op.kind === "write") await this.handlers.write(vaultId, path, op.content);
      else await this.handlers.delete(vaultId, path);
    } catch (err) {
      this.handlers.onError?.(err, vaultId, path);
    } finally {
      this.active -= 1;
      const n = (this.vaultActive.get(vaultId) ?? 1) - 1;
      if (n <= 0) this.vaultActive.delete(vaultId);
      else this.vaultActive.set(vaultId, n);
      this.globalSem.release();
      vaultSem.release();
    }
  }

  /** True while any path has queued or in-flight work. */
  get busy(): boolean {
    return this.chain.size > 0;
  }

  /** Live depth snapshot for server_health / metrics (audit #5). */
  stats(): IndexCoordinatorStats {
    return {
      queued: this.chain.size,
      active: this.active,
      backpressured: this.chain.size > this.queueMax,
      perVaultActive: Object.fromEntries(this.vaultActive),
      coalesced: this.coalesced,
    };
  }

  /** Resolve once all queued + in-flight operations across every path have drained. Used by tests
   *  and graceful shutdown. A chain may re-add itself (a submit during drain), so loop to a fixed
   *  point. */
  async idle(): Promise<void> {
    while (this.chain.size > 0) {
      await Promise.allSettled([...this.chain.values()]);
      // Yield so each settled chain's `.finally` cleanup runs before we re-check size.
      await Promise.resolve();
    }
  }
}
