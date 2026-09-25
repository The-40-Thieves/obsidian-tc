#!/usr/bin/env node
import { spawnSync } from "node:child_process";
// THE-1122 — the "local" embeddings provider's cold-start budget: generate a small deterministic
// vault, index it through the REAL `obsidian-tc index` CLI path with the REAL local embedder (not
// the perf harness's fake, zero-I/O provider), and assert a GENEROUS wall-clock ceiling.
//
// Deliberately generous, not a tight regression gate: this measures a fresh HF model download (on
// a cold CI cache) plus real ONNX CPU inference, both of which vary with the runner's network and
// CPU far more than the synthetic in-process perf harness ever does. The ceiling exists to catch a
// genuine hang or regression (an infinite retry loop, a download that never completes, a
// pathologically slow session load) — not to police ordinary variance. See eval/perf/README.md for
// why the throughput harness itself never measures this: it uses fakeEmbeddingProvider precisely
// so its OWN numbers stay free of exactly this variance.
//
// usage: node scripts/check-cold-start-budget.mjs [--notes N] [--ceiling-ms N]
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PACKAGE_ROOT = join(HERE, "..");

function flagValue(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}
const argv = process.argv.slice(2);
const noteCount = Number(flagValue(argv, "--notes", "500"));
// Generous: a cold model download (~34 MB) + CPU ONNX inference over ~1,000 chunks on a shared CI
// runner. Raise this if it flakes on slow CI network — the point is catching a HANG, not a
// regression budget as tight as the isolated perf gate's.
const ceilingMs = Number(flagValue(argv, "--ceiling-ms", "300000")); // 5 minutes

const workDir = mkdtempSync(join(tmpdir(), "obtc-cold-start-"));
const vaultDir = join(workDir, "vault");
const cacheDir = join(workDir, "cache");
const configPath = join(workDir, "config.json");

try {
  const gen = spawnSync(
    process.execPath,
    [join(PACKAGE_ROOT, "scripts", "gen-cold-start-vault.mjs"), vaultDir, String(noteCount)],
    { stdio: "inherit" },
  );
  if (gen.status !== 0) {
    console.error("cold-start budget: failed to generate the fixture vault");
    process.exit(1);
  }

  writeFileSync(
    configPath,
    JSON.stringify({
      cacheDir,
      vaults: [{ id: "coldstart", path: vaultDir }],
      embeddings: { provider: "local" },
    }),
  );

  // The BUILT CLI (dist/cli.js), same artifact a real install ships — not the TS source, so this
  // measures what an operator actually runs. Callers must `bun run build` first (the CI step below
  // does, via the same build the rest of the job already needs).
  const cliEntry = join(PACKAGE_ROOT, "dist", "cli.js");
  const started = Date.now();
  const result = spawnSync("bun", [cliEntry, "index", configPath], {
    stdio: "inherit",
    timeout: ceilingMs + 30_000, // hard kill well past the budget so a true hang cannot wedge CI
  });
  const elapsedMs = Date.now() - started;

  console.log(
    `cold-start budget: first index of ${noteCount} notes via "local" took ${elapsedMs}ms (ceiling ${ceilingMs}ms)`,
  );

  if (result.error) {
    console.error(`cold-start budget: index command failed to run: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`cold-start budget: "obsidian-tc index" exited ${result.status}`);
    process.exit(1);
  }
  if (elapsedMs > ceilingMs) {
    console.error(
      `cold-start budget EXCEEDED: ${elapsedMs}ms > ${ceilingMs}ms ceiling — likely a hang or genuine regression, not ordinary variance.`,
    );
    process.exit(1);
  }
  console.log("cold-start budget: OK");
} finally {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch (e) {
    console.warn(`cold-start budget: failed to clean up ${workDir}:`, e);
  }
}
