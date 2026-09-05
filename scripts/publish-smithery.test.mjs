// Tests for scripts/publish-smithery.mjs (THE-956).
//
// The `smithery` call goes through an injected fake runner — no subprocess, no network, no real
// key. `classifyPublishResult`/`parsePublishOutput` are pure and tested directly; the "duplicate"
// fixture is explicitly SYNTHETIC — task-5-report.md documents that a live second-publish probe
// of an already-published version never actually produced a distinct duplicate response, so this
// exercises the defensive branch only, not an observed CLI behaviour.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  classifyPublishResult,
  parseArgs,
  parsePublishOutput,
  publishToSmithery,
  SMITHERY_NAME,
} from "./publish-smithery.mjs";

const BUNDLE = "dist/obsidian-tc.mcpb";
const VERSION = "1.27.0";

const REAL_SUCCESS_LINE =
  '{"deploymentId":"415d3cfd-3522-4b93-973f-efb2bebcf0c4","qualifiedName":"the-40-thieves/obsidian-tc","status":"SUCCESS","mcpUrl":"https://obsidian-tc--the-40-thieves.run.tools","statusUrl":"https://smithery.ai/servers/the-40-thieves/obsidian-tc/releases"}';
const REAL_SUCCESS_STDOUT = [
  "Publishing the-40-thieves/obsidian-tc (stdio) to Smithery Registry...",
  "✓ Release 415d3cfd-3522-4b93-973f-efb2bebcf0c4 accepted",
  REAL_SUCCESS_LINE,
  "",
].join("\n");

const ORIGINAL_KEY = process.env.SMITHERY_API_KEY;
afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.SMITHERY_API_KEY;
  else process.env.SMITHERY_API_KEY = ORIGINAL_KEY;
});

// ---- pure helpers ----------------------------------------------------------------------------

test("parsePublishOutput: finds the JSON line after human progress text (real 2026-09-05 shape)", () => {
  const parsed = parsePublishOutput(REAL_SUCCESS_STDOUT);
  assert.equal(parsed.status, "SUCCESS");
  assert.equal(parsed.qualifiedName, "the-40-thieves/obsidian-tc");
});

test("parsePublishOutput: returns null when no JSON line is present", () => {
  assert.equal(parsePublishOutput("smithery: command not found\n"), null);
});

test("classifyPublishResult: SUCCESS is ok", () => {
  const result = classifyPublishResult({
    parsed: {
      status: "SUCCESS",
      qualifiedName: SMITHERY_NAME,
      deploymentId: "d1",
      mcpUrl: "https://x",
    },
    combinedOutput: REAL_SUCCESS_STDOUT,
  });
  assert.equal(result.ok, true);
  assert.match(result.message, /published the-40-thieves\/obsidian-tc/);
});

test("classifyPublishResult: a synthetic duplicate-text response is treated as success (defensive, unobserved live)", () => {
  const result = classifyPublishResult({
    parsed: null,
    combinedOutput: '✗ 400 {"error":"already published"}',
  });
  assert.equal(result.ok, true);
  assert.match(result.message, /already published/);
});

test("classifyPublishResult: a non-SUCCESS, non-duplicate status fails", () => {
  const result = classifyPublishResult({
    parsed: { status: "FAILED" },
    combinedOutput: '{"status":"FAILED"}',
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /status "FAILED"/);
});

test("classifyPublishResult: no parseable output at all fails", () => {
  const result = classifyPublishResult({ parsed: null, combinedOutput: "network error\n" });
  assert.equal(result.ok, false);
  assert.match(result.message, /no parseable JSON status line/);
});

test("parseArgs: requires --bundle and --version", () => {
  assert.throws(() => parseArgs([]), /--bundle is required/);
  assert.throws(() => parseArgs(["--bundle", BUNDLE]), /--version is required/);
});

test("parseArgs: --dry-run is optional and defaults to false", () => {
  const args = parseArgs(["--bundle", BUNDLE, "--version", VERSION]);
  assert.equal(args.dryRun, false);
});

// ---- orchestration (fake runner) -------------------------------------------------------------

test("missing key: fails with a message naming SMITHERY_API_KEY, before any runner call", () => {
  delete process.env.SMITHERY_API_KEY;
  let calls = 0;
  const runner = () => {
    calls++;
    return REAL_SUCCESS_STDOUT;
  };
  assert.throws(
    () => publishToSmithery({ bundle: BUNDLE, version: VERSION, runner }),
    /SMITHERY_API_KEY is empty/,
  );
  assert.equal(calls, 0);
});

test("SUCCESS: publishes and returns the parsed deployment info", () => {
  process.env.SMITHERY_API_KEY = "test-key-not-real";
  const runner = (cmd, args) => {
    assert.equal(cmd, "smithery");
    assert.deepEqual(args, ["mcp", "publish", BUNDLE, "-n", SMITHERY_NAME]);
    return REAL_SUCCESS_STDOUT;
  };
  const result = publishToSmithery({ bundle: BUNDLE, version: VERSION, runner });
  assert.equal(result.action, "published");
});

test("duplicate (synthetic): a second publish is treated as success, not a job failure", () => {
  process.env.SMITHERY_API_KEY = "test-key-not-real";
  const runner = () => {
    const err = new Error("smithery exited 1");
    err.status = 1;
    err.stdout = "";
    err.stderr = '✗ 400 {"error":"already published"}\n';
    throw err;
  };
  const result = publishToSmithery({ bundle: BUNDLE, version: VERSION, runner });
  assert.equal(result.action, "published");
  assert.match(result.message, /already published/);
});

test("other failure: a non-SUCCESS, non-duplicate result fails the job", () => {
  process.env.SMITHERY_API_KEY = "test-key-not-real";
  const runner = () => '{"deploymentId":"d1","qualifiedName":"x/y","status":"FAILED"}';
  assert.throws(
    () => publishToSmithery({ bundle: BUNDLE, version: VERSION, runner }),
    /status "FAILED"/,
  );
});

test("dry-run: prints the plan and never calls the runner (no key needed)", () => {
  delete process.env.SMITHERY_API_KEY;
  let calls = 0;
  const runner = () => {
    calls++;
    return REAL_SUCCESS_STDOUT;
  };
  const result = publishToSmithery({ bundle: BUNDLE, version: VERSION, dryRun: true, runner });
  assert.equal(result.action, "dry-run");
  assert.equal(calls, 0);
});

test("the fake runner never receives the key in argv", () => {
  process.env.SMITHERY_API_KEY = "super-secret-value-xyz";
  const runner = (_cmd, args) => {
    assert.ok(!args.some((a) => a.includes("super-secret-value-xyz")));
    return REAL_SUCCESS_STDOUT;
  };
  publishToSmithery({ bundle: BUNDLE, version: VERSION, runner });
});
