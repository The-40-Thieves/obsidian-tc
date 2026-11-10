// The JSONL session-trace record shape, written by workspace/sessions.ts's `appendTrace` and read
// by its `readTrace` and the session-rerun tooling. A root-level type because both workspace/ and
// mcp/registry/types.ts (dispatch's trace hook) name it, and mcp must not import workspace
// (no-mcp-imports-higher).
export interface TraceRecord {
  ts: number;
  type?: string;
  tool?: string;
  caller?: string | null;
  duration_ms?: number;
  args_hash?: string;
  result_size?: number;
  /** The vault the call acted on; present ONLY when it is not the session's own vault. */
  effect_vault?: string;
  /**
   * THE-736: the dispatch's raw parsed arguments, secret-scanned and size-capped. Present ONLY
   * when `sessions.traceContent` is on — absent is the normal value, not a gap.
   *
   * `args_hash` above stays regardless and is not redundant: it is computed over the UNREDACTED
   * input, so it still identifies a call whose captured text was scrubbed or truncated.
   */
  args?: string;
  /** THE-736: "clean" | "redacted:<n>" | "truncated" — what the scan did on the way in, so a
   *  replay can tell a faithful argument from a scrubbed one BEFORE re-issuing it. */
  args_scan?: string;
  [key: string]: unknown;
}
