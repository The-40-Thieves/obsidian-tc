// THE-923: extracted from bridge/transport.ts (THE-922), which had the only copy of this
// unwrapper even though every fetch-based transport in the server (bridge, embeddings, gateway)
// hits the identical Node/Bun cause-shape split. Kept dependency-free so it stays usable from the
// isomorphic shared package, same as net-host.ts.
const CAUSE_CODE_SHAPE = /^[A-Za-z0-9_]{1,64}$/;

/**
 * Best-effort cause code for a rejected `fetch`, so a caller can tell a TLS trust failure apart
 * from ECONNREFUSED/ENOTFOUND/an abort instead of collapsing every unreachable cause into one
 * opaque failure. Node puts the code on `e.cause.code`; Bun puts it on `e` itself — check both.
 * An `AggregateError` cause (e.g. Node's Happy Eyeballs dual-stack failure) yields its first
 * member. Code string only, and shape-checked: the message/cause object may embed a URL or other
 * free text that must never reach an error payload, so a non-conforming runtime or injected fetch
 * must not smuggle one through `.code`.
 */
export function extractCauseCode(e: unknown): string | undefined {
  const cause = e instanceof Error ? (e.cause as unknown) : undefined;
  const first = cause instanceof AggregateError ? cause.errors[0] : undefined;
  const raw =
    (first as { code?: unknown } | undefined)?.code ??
    (cause as { code?: unknown } | undefined)?.code ??
    (e as { code?: unknown } | undefined)?.code;
  if (typeof raw === "string" && CAUSE_CODE_SHAPE.test(raw)) return raw;
  const name = e instanceof Error ? e.name : undefined;
  return name === "AbortError" || name === "TimeoutError" ? "ABORT_ERR" : undefined;
}
