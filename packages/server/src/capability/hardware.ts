// THE-522 — hardware envelope.
//
// Descriptive only. obsidian-tc is CPU-only by design; this exists so agents and CI can READ the
// machine instead of guessing it, not to gate any GPU path. The node:os baseline is always present;
// systeminformation enrichment is best-effort and degrades to the baseline if it throws (it shells
// out, and a sandboxed/locked-down box can refuse it).
import { arch, cpus, platform, totalmem } from "node:os";

export interface Gpu {
  vendor: string;
  model: string;
  vramMb?: number;
}

export interface HardwareEnvelope {
  platform: string;
  arch: string;
  cpuCount: number;
  totalMemMb: number;
  /** From systeminformation; absent when the enricher was unavailable. */
  cpuBrand?: string;
  hasGpu: boolean;
  gpus: Gpu[];
}

export interface HardwareEnrichment {
  cpuBrand?: string;
  gpus: Gpu[];
}

/**
 * Wall-clock bound on the enricher. systeminformation shells out to the OS: `si.graphics()` runs a
 * WMI query on Windows, which routinely takes seconds on a cold or contended machine and carries no
 * internal timeout of its own. Without a bound here, a hung probe blocks every caller of
 * hardwareEnvelope() indefinitely — including capabilityProfile() — and the degrade-to-baseline path
 * below can never run, because `catch` only fires on rejection and a stalled promise never rejects.
 * 2s is an order of magnitude above the ~50-200ms a healthy probe takes.
 */
const ENRICH_TIMEOUT_MS = 2_000;

/** Best-effort enrichment via systeminformation. Imported lazily so a failure to load the native-ish
 *  module never breaks module import — only the enrichment. */
async function systeminformationEnrichment(): Promise<HardwareEnrichment> {
  const si = await import("systeminformation");
  const [cpu, graphics] = await Promise.all([si.cpu(), si.graphics()]);
  const cpuBrand = [cpu.manufacturer, cpu.brand].filter(Boolean).join(" ").trim() || undefined;
  const gpus: Gpu[] = (graphics.controllers ?? [])
    .filter((c) => c.vendor || c.model)
    .map((c) => ({
      vendor: c.vendor ?? "unknown",
      model: c.model ?? "unknown",
      ...(typeof c.vram === "number" && c.vram > 0 ? { vramMb: c.vram } : {}),
    }));
  return { cpuBrand, gpus };
}

/**
 * Assemble the hardware envelope. `enrich` is injectable for tests; in production it defaults to the
 * systeminformation reader. An enricher that throws OR that exceeds `timeoutMs` degrades to the
 * os-only baseline rather than rejecting — hardware detail is a nice-to-have, never a hard dependency
 * of the profile. Making that contract true requires the timeout: "never a hard dependency" is a
 * claim about latency as much as about errors, and only the bound stops a wedged OS probe from
 * holding the caller open forever.
 */
export async function hardwareEnvelope(
  enrich: () => Promise<HardwareEnrichment> = systeminformationEnrichment,
  timeoutMs: number = ENRICH_TIMEOUT_MS,
): Promise<HardwareEnvelope> {
  const baseline = {
    platform: platform(),
    arch: arch(),
    cpuCount: cpus().length,
    totalMemMb: Math.round(totalmem() / (1024 * 1024)),
  };

  // Cleared in `finally` whichever side wins: if the enricher settles first, an uncleared timer keeps
  // the event loop alive for the full timeoutMs. Note the loser of the race stays subscribed, so a
  // late rejection from `enrich()` is consumed here rather than surfacing as an unhandled rejection.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { cpuBrand, gpus } = await Promise.race([
      enrich(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`hardware enrichment exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
    return { ...baseline, ...(cpuBrand ? { cpuBrand } : {}), hasGpu: gpus.length > 0, gpus };
  } catch {
    return { ...baseline, hasGpu: false, gpus: [] };
  } finally {
    clearTimeout(timer);
  }
}
