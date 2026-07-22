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
 * systeminformation reader. A throwing enricher degrades to the os-only baseline rather than
 * rejecting — hardware detail is a nice-to-have, never a hard dependency of the profile.
 */
export async function hardwareEnvelope(
  enrich: () => Promise<HardwareEnrichment> = systeminformationEnrichment,
): Promise<HardwareEnvelope> {
  const baseline = {
    platform: platform(),
    arch: arch(),
    cpuCount: cpus().length,
    totalMemMb: Math.round(totalmem() / (1024 * 1024)),
  };

  try {
    const { cpuBrand, gpus } = await enrich();
    return { ...baseline, ...(cpuBrand ? { cpuBrand } : {}), hasGpu: gpus.length > 0, gpus };
  } catch {
    return { ...baseline, hasGpu: false, gpus: [] };
  }
}
