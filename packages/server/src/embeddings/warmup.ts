// Background warmup of the "local" embedder. Its first embed() downloads/verifies and loads the
// model, so the first search_semantic (or the boot reconcile) would pay that inside a tool call.
// This runs one tiny embed behind the first client's `initialize` (deferBootWork) so the cost lands
// before the first search instead.
//
// Only the local model benefits: every other provider is a remote call that is either paid or
// reaches a service this process does not own, and a warmup must never issue one. Failure is
// non-fatal (the next real embed() retries, see providers/local-embedder-registry.ts) and is
// logged once; the state is shown in server_health and doctor.
import { BOOT_WARMUP_MAX_WAIT_MS, deferBootWork } from "../runtime/boot-helpers";
import type { EmbeddingProvider } from "./provider";

export type EmbedderWarmupState = "not-applicable" | "pending" | "loading" | "ready" | "failed";

export interface EmbedderWarmupStatus {
  state: EmbedderWarmupState;
  /** Set only while `failed`. May name cache paths: callers gate it like `index.detail`. */
  error?: string;
}

/** True only for the local model. Closed on purpose: a provider added later is excluded until
 *  someone decides a warmup is free for it. */
export function embedderWarmupApplies(providerName: string): boolean {
  return providerName === "local";
}

export interface EmbedderWarmup {
  status(): EmbedderWarmupStatus;
  /** Runs the warmup now. Never rejects; a second call after the first started is a no-op. */
  run(): Promise<void>;
  /** Starts `run` once, behind `initialized` or the cap. Returns its cancel. */
  schedule(opts: { initialized: Promise<void>; maxWaitMs?: number }): () => void;
  /** Stops a warmup that has not started and silences one that has (the load itself cannot be
   *  aborted; its outcome is dropped). Idempotent. */
  cancel(): void;
}

const defaultLog = (msg: string): void => {
  process.stderr.write(`${msg}\n`);
};

export function createEmbedderWarmup(
  provider: Pick<EmbeddingProvider, "provider" | "embed">,
  log: (msg: string) => void = defaultLog,
): EmbedderWarmup {
  const applies = embedderWarmupApplies(provider.provider);
  let status: EmbedderWarmupStatus = { state: applies ? "pending" : "not-applicable" };
  let cancelled = false;
  let cancelScheduled = (): void => {};

  const run = async (): Promise<void> => {
    if (!applies || cancelled || status.state !== "pending") return;
    status = { state: "loading" };
    try {
      // query role: a search-shaped probe is never vault content, so it needs no egress
      // declaration and carries nothing from a note.
      await provider.embed(["warmup"], { input: "query" });
      if (!cancelled) status = { state: "ready" };
    } catch (e) {
      if (cancelled) return;
      const error = e instanceof Error ? e.message : String(e);
      status = { state: "failed", error };
      log(
        `obsidian-tc: embedder warmup failed (${error}); the first semantic search will retry the load`,
      );
    }
  };

  return {
    status: () => status,
    run,
    schedule: ({ initialized, maxWaitMs = BOOT_WARMUP_MAX_WAIT_MS }) => {
      if (!applies) return () => {};
      cancelScheduled = deferBootWork(() => void run(), { initialized, maxWaitMs });
      return cancelScheduled;
    },
    cancel: () => {
      cancelled = true;
      cancelScheduled();
    },
  };
}
