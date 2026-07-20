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

export type IndexOp = { kind: "write"; content: string } | { kind: "delete" };

export interface IndexCoordinatorHandlers {
  /** Apply a (re)index for a path. Resolves when the index commit is durable. */
  write(vaultId: string, path: string, content: string): Promise<unknown> | unknown;
  /** Remove a path from the index. Resolves when the deindex commit is durable. */
  delete(vaultId: string, path: string): Promise<unknown> | unknown;
  /** Reported for a handler that threw; the coordinator never rejects to the caller. */
  onError?(err: unknown, vaultId: string, path: string): void;
}

export class IndexCoordinator {
  // Latest desired state per key (coalescing target); cleared when a drain claims it.
  private readonly latest = new Map<string, IndexOp>();
  // Serialization chain per key; a key's next op awaits its previous op.
  private readonly chain = new Map<string, Promise<void>>();

  constructor(private readonly handlers: IndexCoordinatorHandlers) {}

  private key(vaultId: string, path: string): string {
    // NUL delimiter: vault ids and paths can contain most characters but never a NUL byte.
    return `${vaultId}\u0000${path}`;
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
    this.latest.set(k, op); // coalesce: the newest desired state wins
    const prev = this.chain.get(k) ?? Promise.resolve();
    const next = prev.then(() => this.drain(vaultId, path, k));
    this.chain.set(k, next);
    // Drop the chain entry once it settles, unless a newer submit already replaced it — keeps the
    // map from growing unbounded over a long-lived process without dropping in-flight work.
    void next.finally(() => {
      if (this.chain.get(k) === next) this.chain.delete(k);
    });
  }

  private async drain(vaultId: string, path: string, k: string): Promise<void> {
    const op = this.latest.get(k);
    if (op === undefined) return; // an earlier drain already applied the coalesced latest state
    this.latest.delete(k); // claim it; a newer submit re-adds latest AND chains its own drain
    try {
      if (op.kind === "write") await this.handlers.write(vaultId, path, op.content);
      else await this.handlers.delete(vaultId, path);
    } catch (err) {
      this.handlers.onError?.(err, vaultId, path);
    }
  }

  /** True while any path has queued or in-flight work. */
  get busy(): boolean {
    return this.chain.size > 0;
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
