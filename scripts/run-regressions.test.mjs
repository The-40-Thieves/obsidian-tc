import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runProcess, runSuites, SUITES, selectSuites } from "./run-regressions.mjs";

test("every package and tested Python service has a regression suite", () => {
  assert.ok(
    SUITES.some(
      (suite) => suite.id === "eval-python" && suite.python && suite.args.includes("pytests"),
    ),
  );
  assert.ok(SUITES.some((suite) => suite.id === "docs-build" && suite.cwd === "docs"));
  assert.ok(SUITES.some((suite) => suite.id === "docs-tool-pages" && suite.cwd === "docs"));
  const root = fileURLToPath(new URL("../", import.meta.url));
  for (const group of ["packages", "services"]) {
    for (const entry of readdirSync(resolve(root, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const files = readdirSync(resolve(root, group, entry.name));
      if (!files.includes("package.json") && !files.includes("tests")) continue;
      assert.ok(
        SUITES.some(
          (suite) => suite.cwd === `${group}/${entry.name}` && !suite.id.endsWith("-build"),
        ),
        entry.name,
      );
    }
  }
});

test("selection builds the server before testing and rejects unknown suites", () => {
  assert.ok(SUITES.find((s) => s.id === "plugin").args.includes("--coverage"));
  assert.deepEqual(
    selectSuites(["indexing-e2e"]).map((s) => s.id),
    ["shared-build", "server-build", "indexing-e2e"],
  );
  assert.throws(() => selectSuites(["missing"]), /Unknown suite/);
  assert.equal(
    selectSuites().some((s) => s.id === "indexing-e2e"),
    false,
  );
});

test("the full run includes static, architecture and mirrored-model contract gates", () => {
  const ids = selectSuites().map((suite) => suite.id);
  for (const id of ["lint", "typecheck", "boundaries", "model-parity"]) {
    assert.ok(ids.includes(id), `${id} must run by default`);
    assert.equal(selectSuites([id]).at(-1).id, id);
  }
});

test("failed builds block dependents, independent suites still run, and aggregate remains red", async () => {
  const ran = [];
  const result = await runSuites(
    [{ id: "build" }, { id: "dependent", requires: ["build"] }, { id: "independent" }],
    async (suite) => {
      ran.push(suite.id);
      return {
        status: suite.id === "build" ? "failed" : "passed",
        exitCode: suite.id === "build" ? 1 : 0,
      };
    },
  );
  assert.deepEqual(ran, ["build", "independent"]);
  assert.equal(result.passed, false);
  assert.deepEqual(
    result.results.map((r) => r.status),
    ["failed", "blocked", "passed"],
  );
});

test("missing executables are retained as blocked results instead of silently skipped", async () => {
  const result = await runSuites([{ id: "native" }], async () => ({
    status: "blocked",
    error: "spawn cargo ENOENT",
  }));
  assert.equal(result.passed, false);
  assert.match(result.results[0].error, /ENOENT/);
});

test("cancellation checkpoints completed work and prevents later stages starting", async () => {
  const controller = new AbortController();
  const checkpoints = [];
  const ran = [];
  const result = await runSuites(
    [{ id: "first" }, { id: "later" }],
    async (suite) => {
      ran.push(suite.id);
      controller.abort();
      return { status: "cancelled" };
    },
    () => {},
    { signal: controller.signal, onResult: (rows) => checkpoints.push(rows.length) },
  );
  assert.equal(result.passed, false);
  assert.deepEqual(ran, ["first"]);
  assert.deepEqual(checkpoints, [1, 2]);
  assert.deepEqual(
    result.results.map((r) => r.status),
    ["cancelled", "cancelled"],
  );
});

test("a stalled child is terminated and reported as failed", { timeout: 10_000 }, async () => {
  const result = await runProcess(
    { cwd: ".", command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] },
    { timeoutMs: 150 },
  );
  assert.equal(result.status, "failed");
  assert.match(result.error, /timeout/);
});
