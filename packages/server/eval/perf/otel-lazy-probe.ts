// THE-515: structural guard for the exact regression this ticket measured (see boot-probe.ts's
// header for the full cold-start story). Importing the published barrel (index.ts, which
// re-exports ToolRegistry) MUST NOT drag the OTEL SDK into the module graph at import time — the
// SDK is supposed to load only inside initOtel's `endpoint` branch, which this probe never calls.
//
// Same subprocess requirement as boot-probe.ts, and for the same reason: once a process has
// imported a module, timing a LATER import of it reports a near-zero module-cache hit regardless
// of whether the FIRST import already paid the real cost. A fresh subprocess per run is the only
// way to tell "already loaded by index.ts" apart from "not loaded yet". This is the same
// discriminator used to originally measure the defect (registry.ts import followed by a timed
// otel-sdk import: ~0.1ms when already cached, several ms when genuinely cold).
import { performance } from "node:perf_hooks";

export interface OtelLazyProbeResult {
  /** ms to import the published barrel. */
  index_import_ms: number;
  /** ms to import an OTEL SDK package AFTER index.ts is loaded. Near-zero means the module was
   *  already in the cache — i.e. index.ts's import graph pulled it in eagerly, the regression
   *  this guard exists to catch. A real cold-import time means it was not loaded. */
  otel_sdk_after_index_ms: number;
}

/** Below this, treat the import as a module-cache hit rather than a genuine cold load. The
 *  measured cache-hit cost is ~0.1-0.2ms (boot-probe.ts's own "prom-after-registry" control uses
 *  the same discriminator); a real cold import of an OTEL SDK package costs several ms minimum
 *  because it pulls in its own dependency tree. Comfortable headroom either side. */
export const CACHE_HIT_THRESHOLD_MS = 2;

export async function runOtelLazyProbe(): Promise<OtelLazyProbeResult> {
  const t0 = performance.now();
  await import("../../src/index");
  const index_import_ms = performance.now() - t0;

  const t1 = performance.now();
  await import("@opentelemetry/sdk-trace-node");
  const otel_sdk_after_index_ms = performance.now() - t1;

  return { index_import_ms, otel_sdk_after_index_ms };
}

// Only when run directly as a subprocess; importing for tests does not print. The single JSON
// line on stdout IS the protocol, matching boot-probe.ts's convention.
if ((import.meta as unknown as { main?: boolean }).main) {
  runOtelLazyProbe()
    .then((r) => process.stdout.write(`${JSON.stringify(r)}\n`))
    .catch((e: unknown) => {
      process.stderr.write(`otel lazy probe failed: ${e instanceof Error ? e.stack : String(e)}\n`);
      process.exit(1);
    });
}
