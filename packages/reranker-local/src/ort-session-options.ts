// GH #995 — onnxruntime-node intra-/inter-op thread pool sizing shared between embedder-local and
// reranker-local. This is a DELIBERATE MIRROR of
// packages/embedder-local/src/ort-session-options.ts, not an import from it or from
// packages/shared — same reasoning as model-fetch.ts's header comment in both packages: neither
// optional package may depend on the other, and packages/shared is a real dependency (zod plus a
// dozen unrelated config schemas) neither package wants to pull in for two small functions. Kept
// dependency-free of Node fs/network so it stays as portable as the rest of each package's public
// surface; the one Node import (`node:os`) is confined to the thin `availableParallelism`
// re-export below, never called from inside the pure function itself. If this logic changes,
// change it in both packages.
//
// THE REGRESSION THIS CLOSES: this package's own `from_pretrained` call passed NO session options
// at all, so onnxruntime-node sized its own intra-op pool from the PHYSICAL CORE COUNT, uncapped,
// with worker threads busy-spinning between batches. Every stdio MCP client spawns its own server
// process, so N clients meant N full-core thread pools spinning up during boot reconcile alone
// (see embedder-local's copy of this file, and GH #995, for the embedder-local sibling that was
// measured directly: 1 instance ~550% CPU / 2.4GB RSS; 4 instances -> load avg 211 on a 12-core
// M3 Pro).
import { availableParallelism } from "node:os";

export interface OrtSessionOptions {
  intraOpNumThreads: number;
  interOpNumThreads: number;
  /** onnxruntime-node's own escape hatch for raw ORT session config keys with no dedicated
   *  top-level SessionOptions field (`session.intra_op.allow_spinning` /
   *  `session.inter_op.allow_spinning` / `session.disable_prepacking`). A capped thread COUNT
   *  alone does not stop a worker thread from pinning a full core at 100% busy-waiting for the
   *  next op between batches — disabling spinning is what actually returns that core to idle.
   *  `session.disable_prepacking` ("1" disables it; confirmed against onnxruntime's own
   *  `kOrtSessionOptionsConfigDisablePrepacking` in
   *  `include/onnxruntime/core/session/onnxruntime_session_options_config_keys.h` — the bundled
   *  `.d.ts` comment for `onnxruntime-node`'s `extra` field is stale and does not list it, but the
   *  native binding forwards the key unfiltered) skips PrePack()'s eager, single-shot repacking of
   *  every constant-initializer weight into each execution provider's preferred layout during
   *  session Initialize() — a one-time cost this process pays on every boot for weights it may
   *  reuse across a long process lifetime either way, so the transform buys nothing here and only
   *  adds init latency/RSS. Measured on Cave (ARM64, Bun 1.4.2, transformers.js 4.3.0,
   *  nomic-embed-text-v1.5 q8, embedder-local sibling): RSS 337->257 MB, session load
   *  1164->516 ms, embed ~29% faster. */
  extra: {
    session: {
      intra_op: { allow_spinning: string };
      inter_op: { allow_spinning: string };
      disable_prepacking: string;
    };
  };
}

/** `cpuCount` is an explicit parameter rather than calling `availableParallelism()` internally —
 *  keeps this function pure and trivially testable (1, 2, 4, 12, 64 cores -> 1, 1, 1, 3, 16
 *  intra-op threads) with no `node:os` mocking. Callers pass `availableParallelism()` (re-exported
 *  below so neither loadSession call site needs its own `node:os` import just for this one call).
 *
 *  `threads` is `embeddings.threads` (embedder-local) / not yet a config knob at all
 *  (reranker-local, GH #995): when set, it wins outright for BOTH intra- and inter-op — preserving
 *  the pre-#995 behavior for anyone already setting it explicitly — and spinning/prepacking stay
 *  disabled regardless; an explicit thread count is not an opt-out of either fix, since a low,
 *  explicit count can still spin a core at 100% between batches, and prepacking cost is
 *  independent of the thread pool size entirely.
 *
 *  The default divides by 4 (floored, minimum 1) rather than claiming every physical core: this
 *  process is one of potentially several stdio MCP server instances (one per client) plus whatever
 *  else is running on the host, so the default deliberately leaves headroom instead of maximizing
 *  single-process throughput. */
export function ortSessionOptions(
  threads: number | undefined,
  cpuCount: number,
): OrtSessionOptions {
  const intraOpNumThreads = threads ?? Math.max(1, Math.floor(cpuCount / 4));
  const interOpNumThreads = threads ?? 1;
  return {
    intraOpNumThreads,
    interOpNumThreads,
    extra: {
      session: {
        intra_op: { allow_spinning: "0" },
        inter_op: { allow_spinning: "0" },
        disable_prepacking: "1",
      },
    },
  };
}

export { availableParallelism };
