import type { EmbedderHost, EmbedderHostState, EmbedderRecycleReason } from "./types";

/** What a loaded embedder package session exposes: just the embed call. */
export interface LoadedEmbedder {
  embed(texts: string[], opts?: unknown): Promise<number[][]>;
}

/** The model runs inside this process. The load is memoized, but a rejected load is NOT: a
 *  transient failure (package not built yet, model not downloadable) must not wedge the provider
 *  for the life of the process. */
export function createInProcessHost(load: () => Promise<LoadedEmbedder>): EmbedderHost {
  let pending: Promise<LoadedEmbedder> | undefined;
  let state: EmbedderHostState = "idle";
  let recycles = 0;
  const session = (): Promise<LoadedEmbedder> => {
    if (!pending) {
      state = "loading";
      pending = (async () => load())().then(
        (loaded) => {
          state = "ready";
          return loaded;
        },
        (error: unknown) => {
          state = "failed";
          pending = undefined;
          throw error;
        },
      );
    }
    return pending;
  };
  return {
    kind: "in-process",
    embed: async (texts, opts) => (await session()).embed(texts, opts),
    // An in-process ONNX Runtime cannot hand its memory back to the OS, and dropping the loaded
    // model would only reload the same weights. Counted so the stats show the request, no action.
    recycle: async (_reason: EmbedderRecycleReason) => {
      recycles += 1;
    },
    stats: async () => ({ state, restarts: 0, recycles }),
    close: async () => {},
  };
}
