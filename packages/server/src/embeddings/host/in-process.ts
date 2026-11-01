import type { EmbedderHost, EmbedderHostState, EmbedderRecycleReason } from "./types";

/** What a loaded embedder package session exposes: just the embed call. */
export interface LoadedEmbedder {
  embed(texts: string[], opts?: unknown): Promise<number[][]>;
}

/** The model runs inside this process. The loader owns memoization (the provider's session() memo
 *  already keeps a rejected load from being retained), so this host calls it on every embed and only
 *  tracks state. */
export function createInProcessHost(load: () => Promise<LoadedEmbedder>): EmbedderHost {
  let state: EmbedderHostState = "idle";
  let recycles = 0;
  const session = async (): Promise<LoadedEmbedder> => {
    state = "loading";
    try {
      const loaded = await load();
      state = "ready";
      return loaded;
    } catch (error) {
      state = "failed";
      throw error;
    }
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
    snapshot: () => ({ state, restarts: 0, recycles }),
    close: async () => {},
  };
}
