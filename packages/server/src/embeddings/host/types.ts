// The seam between an embedding provider and whatever actually holds the model: in this process
// (in-process.ts) or in a child process the host spawns and can drain (child-process.ts).

export type EmbedderHostKind = "in-process" | "child-process";

export type EmbedderRecycleReason = "reconcile" | "budget" | "manual";

export type EmbedderHostState = "idle" | "loading" | "ready" | "draining" | "failed";

export interface EmbedderHostStats {
  state: EmbedderHostState;
  restarts: number;
  recycles: number;
  rssBytes?: number;
  /** The child's pid while one is running (child-process hosts only). */
  pid?: number;
}

export interface EmbedderHost {
  readonly kind: EmbedderHostKind;
  embed(texts: string[], opts?: unknown): Promise<number[][]>;
  recycle(reason: EmbedderRecycleReason): Promise<void>;
  stats(): Promise<EmbedderHostStats>;
  close(): Promise<void>;
}
