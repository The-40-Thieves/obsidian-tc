/**
 * Micro-benchmark for the pure-JavaScript hardened vault read.
 *
 *   bun eval/perf/fallback-read-bench.ts [--reads 2000] [--samples 7]
 *
 * Each sample reads one note through four nested directories. The fallback backend is forced before
 * notes-io is imported so the native no-follow implementation cannot affect the measurement.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function stats(values: number[]): { mean: number; sd: number; cv: number } {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sd = Math.sqrt(
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1 || 1),
  );
  return { mean, sd, cv: mean === 0 ? 0 : sd / mean };
}

const READS = arg("reads", 2_000);
const SAMPLES = arg("samples", 7);
const root = mkdtempSync(join(tmpdir(), "obtc-fallback-read-bench-"));
const note = join(root, "one", "two", "three", "four", "note.md");
mkdirSync(join(root, "one", "two", "three", "four"), { recursive: true });
writeFileSync(note, "fallback read benchmark\n");

process.env.OBSIDIAN_TC_FORCE_JS_FALLBACK = "1";
const { nativeVaultIo, readNote } = await import("../../src/vault/notes-io");
if (nativeVaultIo !== false) throw new Error("benchmark did not force the JavaScript fallback");

function run(): void {
  for (let index = 0; index < READS; index++) readNote(note);
}

try {
  for (let warmup = 0; warmup < 3; warmup++) run();
  const samples: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample++) {
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  const { mean, sd, cv } = stats(samples);
  const readsPerSecond = (READS / mean) * 1_000;

  console.log(
    `fallback read (${READS} reads, depth 4): ${mean.toFixed(2)} ms ± ${sd.toFixed(2)} (cv ${(cv * 100).toFixed(1)}%), ${readsPerSecond.toFixed(0)} reads/s`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
