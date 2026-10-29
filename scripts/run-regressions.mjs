#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitest = (cwd, args = []) => ({
  cwd,
  command: process.execPath,
  args: ["./node_modules/vitest/vitest.mjs", "run", "--maxWorkers=2", ...args],
});
const build = (cwd) => ({ cwd, command: "bun", args: ["run", "build"] });

// The optional model packages and Python services are outside the Bun workspace list.
// Keep their suites explicit so a workspace-only pass cannot masquerade as repository coverage.
export const SUITES = [
  { id: "lint", cwd: ".", command: "bun", args: ["run", "lint"] },
  { id: "typecheck", cwd: ".", command: "bun", args: ["run", "typecheck"] },
  { id: "boundaries", cwd: ".", command: process.execPath, args: ["scripts/check-boundaries.mjs"] },
  {
    id: "model-parity",
    cwd: ".",
    command: process.execPath,
    args: ["scripts/check-model-fetch-parity.mjs"],
  },
  { id: "shared-build", ...build("packages/shared") },
  { id: "server-build", ...build("packages/server"), requires: ["shared-build"] },
  { id: "plugin-build", ...build("packages/plugin") },
  { id: "shared", ...vitest("packages/shared") },
  { id: "plugin", ...vitest("packages/plugin", ["--coverage"]) },
  {
    id: "server",
    ...vitest("packages/server"),
    requires: ["server-build"],
  },
  {
    id: "indexing-e2e",
    ...vitest("packages/server", ["test/vault-lifecycle-e2e.test.ts"]),
    requires: ["server-build"],
  },
  { id: "bun-sqlite", cwd: "packages/server", command: "bun", args: ["test", "bun-smoke"] },
  { id: "embedder-build", ...build("packages/embedder-local") },
  { id: "embedder", ...vitest("packages/embedder-local"), requires: ["embedder-build"] },
  { id: "reranker-build", ...build("packages/reranker-local") },
  { id: "reranker", ...vitest("packages/reranker-local"), requires: ["reranker-build"] },
  { id: "native", cwd: "packages/native", command: "cargo", args: ["test", "--locked"] },
  { id: "native-build-script", ...vitest("packages/native") },
  {
    id: "scripts",
    cwd: ".",
    requires: ["embedder-build", "reranker-build"],
    command: process.execPath,
    args: [
      "scripts/with-tmp-guard.mjs",
      process.execPath,
      "--test",
      "--test-concurrency=2",
      "scripts/*.test.mjs",
      "examples/web-client/*.test.mjs",
    ],
  },
  { id: "bge-service", cwd: "services/bge-m3-service", python: true },
  { id: "docs-ingest", cwd: "services/docs-ingest", python: true },
  {
    id: "eval-python",
    cwd: "packages/server/eval",
    python: true,
    args: ["-m", "pytest", "-q", "pytests"],
  },
  { id: "docs-build", ...build("docs"), requires: ["server-build"] },
  {
    id: "docs-tool-pages",
    cwd: "docs",
    command: "bun",
    args: ["run", "check:tool-pages"],
    requires: ["docs-build"],
  },
];

export function selectSuites(ids = []) {
  const selected = new Map();
  const visiting = new Set();
  function add(id) {
    if (selected.has(id)) return;
    const suite = SUITES.find((entry) => entry.id === id);
    if (!suite) throw new Error(`Unknown suite: ${id}. Use --list.`);
    if (visiting.has(id)) throw new Error(`Cyclic suite prerequisite: ${id}`);
    visiting.add(id);
    for (const dependency of suite.requires ?? []) add(dependency);
    visiting.delete(id);
    selected.set(id, suite);
  }
  // The full server suite already contains the lifecycle test; avoid running it twice.
  for (const id of ids.length
    ? ids
    : SUITES.filter((s) => s.id !== "indexing-e2e").map((s) => s.id)) {
    add(id);
  }
  return [...selected.values()];
}

export function runProcess(suite, { signal, timeoutMs = 3_600_000 } = {}) {
  const command = suite.python ? (process.env.REGRESSION_PYTHON ?? "python") : suite.command;
  const args = suite.args ?? (suite.python ? ["-m", "pytest", "-q"] : []);
  const env = { ...process.env };
  // Live companion tests require a separately selected scratch Obsidian instance.
  // This runner never inherits an opt-in that might target a user's active vault.
  delete env.OBSIDIAN_TC_LIVE;
  return new Promise((accept) => {
    let stopReason;
    const child = spawn(command, args, {
      cwd: resolve(ROOT, suite.cwd),
      env,
      stdio: "inherit",
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const stop = (reason) => {
      if (stopReason) return;
      stopReason = reason;
      if (!child.pid) return;
      if (process.platform === "win32") {
        // Kill only the tree created for this stage, including test workers.
        // Absolute path: resolving taskkill through PATH would run whatever a writable PATH entry holds.
        const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
        const killer = spawn(taskkill, ["/pid", String(child.pid), "/t", "/f"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.once("error", () => child.kill());
        killer.once("exit", (code) => {
          if (code !== 0) child.kill();
        });
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    const abort = () => stop("cancelled");
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    const finish = (outcome) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      accept(outcome);
    };
    child.once("error", (error) => finish({ status: "blocked", error: error.message }));
    child.once("exit", (code, exitSignal) =>
      finish({
        status:
          stopReason === "cancelled"
            ? "cancelled"
            : code === 0 && !stopReason
              ? "passed"
              : "failed",
        exitCode: code,
        signal: exitSignal,
        ...(stopReason
          ? {
              error:
                stopReason === "timeout" ? `Exceeded ${timeoutMs}ms stage timeout` : "Interrupted",
            }
          : {}),
      }),
    );
    if (signal?.aborted) abort();
  });
}

export async function runSuites(suites, run = runProcess, report = () => {}, options = {}) {
  const results = [];
  for (const suite of suites) {
    const failedDependencies = (suite.requires ?? []).filter(
      (id) => results.find((result) => result.id === id)?.status !== "passed",
    );
    const started = Date.now();
    report(`regressions: ${suite.id}`);
    const outcome = options.signal?.aborted
      ? { status: "cancelled", error: "Interrupted before stage started" }
      : failedDependencies.length
        ? {
            status: "blocked",
            error: `Prerequisites did not pass: ${failedDependencies.join(", ")}`,
          }
        : await run(suite, options);
    results.push({ id: suite.id, ...outcome, durationMs: Date.now() - started });
    options.onResult?.(results);
  }
  return { passed: results.every((r) => r.status === "passed"), results };
}

export async function main(args = process.argv.slice(2)) {
  const ids = [];
  let reportPath;
  let list = false;
  let timeoutMs = 3_600_000;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--list") list = true;
    else if (args[i] === "--suite" && args[i + 1]) ids.push(...args[++i].split(","));
    else if (args[i] === "--report" && args[i + 1]) reportPath = resolve(args[++i]);
    else if (args[i] === "--timeout-ms" && args[i + 1]) timeoutMs = Number(args[++i]);
    else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new Error("--timeout-ms must be a positive integer no greater than 2147483647");
  }
  if (list) {
    console.log(SUITES.map((s) => `${s.id}\t${s.cwd}`).join("\n"));
    return 0;
  }
  const selection = selectSuites(ids);
  const startedAt = new Date().toISOString();
  const checkpoint = (report) => {
    if (!reportPath) return;
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(
      reportPath,
      `${JSON.stringify({ startedAt, selected: selection.map((s) => s.id), ...report }, null, 2)}\n`,
    );
  };
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  let result;
  try {
    checkpoint({ complete: false, passed: false, results: [] });
    result = await runSuites(selection, undefined, console.log, {
      signal: controller.signal,
      timeoutMs,
      onResult: (results) => checkpoint({ complete: false, passed: false, results }),
    });
    checkpoint({ complete: true, finishedAt: new Date().toISOString(), ...result });
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
  console.log(
    result.results.map((r) => `${r.id}: ${r.status}${r.error ? ` (${r.error})` : ""}`).join("\n"),
  );
  return result.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
