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

/**
 * How long deferBootWork waits for a first `initialize` before starting the warmup anyway. A stdio
 * client sends `initialize` the moment it spawns the process, so the cap only bounds a client that
 * never does (a probe, a test harness) and HTTP, whose sessions are not observable from here; a
 * longer wait buys nothing and starves the index of a reconcile when no handshake ever comes.
 */
export const BOOT_WARMUP_MAX_WAIT_MS = 2_000;

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

/**
 * Starts boot warmup (the reconcile: vault walk, parse, chunk, embed) behind the first client's
 * `initialize`, so none of its synchronous first segment runs ahead of the first request. Open WebUI
 * gives `initialize` about 10 s and Codex gives startup 10 s; the whole-vault walk alone costs
 * ~0.3 s per 20 000 notes and scales with disk latency.
 *
 * `work` starts exactly once, on a LATER macrotask than whatever resolved `initialized` (so the
 * initialize response has already been written), after `initialized` resolves or after `maxWaitMs`,
 * whichever comes first. The cap exists for transports that never fire `oninitialized` (stateless
 * HTTP). Returns a cancel function: once called, `work` never starts.
 */
export function deferBootWork(
  work: () => void,
  opts: { initialized: Promise<void>; maxWaitMs: number },
): () => void {
  let armed = true;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const disarm = (): void => {
    armed = false;
    for (const t of timers) clearTimeout(t);
    timers.clear();
  };
  const later = (ms: number): void => {
    const t = setTimeout(() => {
      if (!armed) return;
      disarm();
      work();
    }, ms);
    t.unref();
    timers.add(t);
  };
  later(opts.maxWaitMs);
  void opts.initialized.then(() => later(0));
  return disarm;
}
