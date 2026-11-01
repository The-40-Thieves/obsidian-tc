// The seam between an embedding provider and whatever actually holds the model. Step 1 ships only
// the in-process implementation; the child-process kind is reserved for the recyclable embedder.

export type EmbedderHostKind = "in-process" | "child-process";

export type EmbedderRecycleReason = "reconcile" | "budget" | "manual";

export type EmbedderHostState = "idle" | "loading" | "ready" | "draining" | "failed";

export interface EmbedderHostStats {
  state: EmbedderHostState;
  restarts: number;
  recycles: number;
  rssBytes?: number;
}

export interface EmbedderHost {
  readonly kind: EmbedderHostKind;
  embed(texts: string[], opts?: unknown): Promise<number[][]>;
  recycle(reason: EmbedderRecycleReason): Promise<void>;
  stats(): Promise<EmbedderHostStats>;
  close(): Promise<void>;
}
