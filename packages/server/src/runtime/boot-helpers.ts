// Small, dependency-free boot-lifecycle primitives shared by server-runtime.ts's `wireRuntimeCore`
// and `buildServerRuntime` (and re-exported from there — see that file's header — so every existing
// caller/test import path keeps working). Split out to keep server-runtime.ts under biome's 700-line
// noExcessiveLinesPerFile cap: this trio carries no runtime-specific wiring of its own, so lifting it
// is a clean split rather than the circular-import trap CLAUDE.md warns a naive one creates.

/** Guards a boot resource captured by a closure before its own `const`/`let` has run: throws (never
 *  a non-null assertion — forbidden by lint) if the closure is ever invoked early. THE-466. Shared
 *  by `wireRuntimeCore`'s `indexHealth` forward-reference and cli.ts's
 *  `indexCoordinatorRef`/`schedulerRef`. See docs/design/server-runtime.md. */
export function requireBoot<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} read before boot completed`);
  return value;
}

/** THE-906: the boot ready line's `native=` token. `active` MUST be `nativeBindingActive` (the
 *  real napi binding serving), never `nativeResolved` — the latter stays true even when
 *  `packages/native/index.js` silently substituted its own JS fallback.js (#857), which would
 *  print `native=on` on a process that is, in fact, running pure JS. */
export function nativeReadyToken(active: boolean): "on" | "js-fallback" {
  return active ? "on" : "js-fallback";
}

/** `name` is a plain `string`, not a closed union — `wireRuntimeCore` and `buildServerRuntime` each
 *  push their own fixed set of layer names onto the same `OwnedLayer`/`unwindReversed` machinery. */
export interface OwnedLayer {
  name: string;
  close(): void | Promise<void>;
}

/**
 * Runs each already-built layer's cleanup in REVERSE (most-recently-opened-first) order — the
 * resource-acquisition-is-cleanup pattern used when a later wiring step throws. A layer that was
 * never built never contributes a cleanup call. Exported and independently tested; see
 * server-runtime.test.ts.
 */
export async function unwindReversed(
  layers: readonly OwnedLayer[],
  onCleanup?: (name: OwnedLayer["name"]) => void,
): Promise<void> {
  for (const layer of [...layers].reverse()) {
    await layer.close();
    onCleanup?.(layer.name);
  }
}
