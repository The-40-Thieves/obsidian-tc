// Tests for the cross-platform pieces of the boundary gate (scripts/check-boundaries.mjs).
//
// Uses node:test rather than vitest: this repo has no test runner wired for scripts/ at all
// (`bun run test` == `bun run --filter='*' test`, which only reaches the four package
// workspaces — root-level scripts are outside every workspace's glob, and there is no root
// vitest config). node:test needs zero configuration to execute a file directly, so this is the
// placement that actually runs rather than sitting inert next to a runner that never reaches it:
//
//   node --test scripts/check-boundaries.test.mjs
//
// A `test:scripts` script is added to the root package.json (`node --test scripts/*.test.mjs`)
// so the suite has a documented, discoverable entry point — it is intentionally not wired into
// `bun run test` or any CI job here, since that is a job/workflow decision outside this change.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDependencyCruiserCommand,
  parseDependencyCruiserReport,
  resolveDependencyCruiserCli,
} from "./check-boundaries.mjs";

// The "importing has no side effects" check deliberately lives in its own file
// (check-boundaries-import.test.mjs), NOT here. This file's own top-level import of
// check-boundaries.mjs (above) already depends on that property holding — if the entry-point
// guard ever regresses, main() runs during THIS import and calls process.exit(), which kills this
// file's process before any test() below registers. node's test runner reports a file that
// registered zero tests as a trivial "1 passed" (verified empirically: a *.test.mjs with no
// test() calls at all still prints "tests 1 / pass 1"), so a same-file test could never observe
// the regression it exists to catch. Isolating it in a file that never imports the module
// statically is what makes it capable of going red.

test("buildDependencyCruiserCommand: Windows paths pass through untouched (no npx/npx.cmd shim)", () => {
  const execPath = "C:\\Program Files\\nodejs\\node.exe";
  const cliPath = "C:\\repo\\node_modules\\dependency-cruiser\\bin\\dependency-cruise.mjs";

  const { command, args } = buildDependencyCruiserCommand(["src/a.ts"], { execPath, cliPath });

  // The whole point of the fix: invoke node directly on the resolved CLI script, never a
  // package-manager shim. On a real Windows box a bare "npx" throws ENOENT under execFileSync's
  // shell:false; command must be the node binary itself, not "npx"/"npx.cmd".
  assert.equal(command, execPath);
  assert.equal(args[0], cliPath);
});

test("buildDependencyCruiserCommand: arg order is exactly [cli, ...files, --config, ..., --ignore-known, --output-type, json]", () => {
  const files = [
    "packages/server/src/a.ts",
    "packages/server/src/b.ts",
    "packages/shared/src/c.ts",
  ];

  const { args } = buildDependencyCruiserCommand(files, { cliPath: "/fake/dependency-cruise.mjs" });

  assert.deepEqual(args, [
    "/fake/dependency-cruise.mjs",
    "packages/server/src/a.ts",
    "packages/server/src/b.ts",
    "packages/shared/src/c.ts",
    "--config",
    ".dependency-cruiser.cjs",
    "--ignore-known",
    "--output-type",
    "json",
  ]);
});

test("buildDependencyCruiserCommand: defaults execPath to process.execPath and resolves cliPath when omitted", () => {
  const { command } = buildDependencyCruiserCommand(["src/a.ts"], {
    cliPath: "/fake/dependency-cruise.mjs",
  });

  assert.equal(command, process.execPath);
});

test("resolveDependencyCruiserCli: throws a clear error when the resolved bin does not exist", () => {
  const fakeResolve = (specifier) => {
    assert.equal(specifier, "dependency-cruiser");
    return "file:///nonexistent/node_modules/dependency-cruiser/src/main/index.mjs";
  };

  assert.throws(
    () => resolveDependencyCruiserCli(fakeResolve),
    (err) => {
      assert.match(err.message, /dependency-cruiser CLI not found/);
      assert.match(err.message, /nonexistent.*bin.*dependency-cruise\.mjs/s);
      return true;
    },
  );
});

test("resolveDependencyCruiserCli: resolves the real installed CLI from the package entry point", () => {
  // No injected resolve — exercises the real import.meta.resolve("dependency-cruiser") path
  // against whatever is actually installed in node_modules, proving the walk (entry -> ../../bin)
  // matches the real package layout rather than only a mocked one.
  const cli = resolveDependencyCruiserCli();
  assert.match(cli, /bin[\\/]dependency-cruise\.mjs$/);
});

test("parseDependencyCruiserReport: parses a string", () => {
  const report = parseDependencyCruiserReport('{"summary":{"totalCruised":1}}');
  assert.deepEqual(report, { summary: { totalCruised: 1 } });
});

test("parseDependencyCruiserReport: parses a Buffer", () => {
  const report = parseDependencyCruiserReport(
    Buffer.from('{"summary":{"totalCruised":2}}', "utf8"),
  );
  assert.deepEqual(report, { summary: { totalCruised: 2 } });
});
