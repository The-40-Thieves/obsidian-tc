// THE-625 item 1: the `e instanceof Error ? e.message : String(e)` ternary appeared 6 times in
// cli.ts alone (11 across packages/server/src) — a caught value is not guaranteed to be an Error
// (throw "x", throw 42, a rejected promise from a library that doesn't use Error), so every one of
// those call sites needs the same guard. One helper, not a repeated idiom free to drift.

/** The best-effort human-readable message for a caught `unknown`. Never throws. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** THE-625 item 2: the `onError: (e) => process.stderr.write(\`[tag] ${msg}\n\`)` boot-wiring shape,
 *  repeated verbatim at several call sites. Only sites matching this EXACT shape should convert —
 *  one that carries extra context beyond the tag would lose it and must keep its own lambda. */
export function stderrOnError(tag: string): (e: unknown) => void {
  return (e) => process.stderr.write(`[${tag}] ${errorMessage(e)}\n`);
}
