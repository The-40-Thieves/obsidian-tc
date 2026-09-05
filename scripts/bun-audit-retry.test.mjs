// Off-runner test for .github/actions/bun-audit/run.sh (THE-953). Runs the REAL run.sh (not a JS
// reimplementation) against a fake `bun` on PATH, so a regression in the script the composite
// action actually calls is what this test would catch -- same "extract and run the real thing"
// reasoning as check-npm-identifier-encoding.test.mjs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const RUN_SH = fileURLToPath(new URL("../.github/actions/bun-audit/run.sh", import.meta.url));

let dirs = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function makeTmpDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** An executable fake `bun` on its own PATH dir. `body` is the shell handling the `audit`
 *  subcommand (already inside `if [ "$1" = audit ]`). */
function makeBunShim(body) {
  const binDir = makeTmpDir("bun-audit-shim-");
  writeFileSync(
    join(binDir, "bun"),
    `#!/usr/bin/env bash\nif [ "$1" != "audit" ]; then echo "unexpected args: $*" >&2; exit 2; fi\n${body}\n`,
  );
  chmodSync(join(binDir, "bun"), 0o755);
  return binDir;
}

/** Run the real run.sh with the fake bun on PATH and a 0s backoff, so the test is instant
 *  (BUN_AUDIT_BACKOFF_SECONDS overrides the composite action's real 30/60/120 default). */
function runAudit(binDir, { attempts = "3" } = {}) {
  const cwd = makeTmpDir("bun-audit-cwd-");
  try {
    const output = execFileSync("bash", [RUN_SH, cwd], {
      encoding: "utf8",
      env: {
        PATH: `${binDir}:${process.env.PATH}`,
        BUN_AUDIT_ATTEMPTS: attempts,
        BUN_AUDIT_BACKOFF_SECONDS: "0 0",
      },
    });
    return { status: 0, output };
  } catch (err) {
    return { status: err.status, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

test("a clean audit (exit 0) succeeds on the first attempt, no retry", () => {
  const binDir = makeBunShim('echo "0 vulnerabilities found"\nexit 0');
  const { status, output } = runAudit(binDir);
  assert.equal(status, 0);
  assert.match(output, /attempt 1\/3/);
  assert.doesNotMatch(output, /attempt 2/);
});

test("a real finding (a vulnerability table, no registry marker) fails on the FIRST attempt, unretried", () => {
  const binDir = makeBunShim('echo "GHSA-xxxx-xxxx-xxxx  high  some-package  1.0.0"\nexit 1');
  const { status, output } = runAudit(binDir);
  assert.equal(status, 1);
  assert.match(output, /attempt 1\/3/);
  assert.doesNotMatch(output, /attempt 2/);
  assert.doesNotMatch(output, /::error title=npm advisory endpoint outage::/);
});

test("a bad-lockfile-shaped non-zero exit (no registry marker) also fails on the FIRST attempt", () => {
  const binDir = makeBunShim('echo "error: lockfile is out of date"\nexit 1');
  const { status, output } = runAudit(binDir);
  assert.equal(status, 1);
  assert.doesNotMatch(output, /attempt 2/);
});

test("a registry 503 is retried and succeeds once the outage clears", () => {
  const counterDir = makeTmpDir("bun-audit-counter-");
  const counter = join(counterDir, "count");
  writeFileSync(counter, "0");
  const binDir = makeBunShim(
    [
      `count=$(cat "${counter}")`,
      "count=$((count + 1))",
      `echo "$count" > "${counter}"`,
      'if [ "$count" -lt 3 ]; then',
      '  echo "request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed, reason: 503"',
      "  exit 1",
      "fi",
      'echo "0 vulnerabilities found"',
      "exit 0",
    ].join("\n"),
  );
  const { status, output } = runAudit(binDir);
  assert.equal(status, 0);
  assert.match(output, /attempt 1\/3/);
  assert.match(output, /attempt 2\/3/);
  assert.match(output, /attempt 3\/3/);
  assert.equal(readFileSync(counter, "utf8").trim(), "3");
});

test("every attempt is a registry timeout: fails after 3 attempts with the outage message", () => {
  const binDir = makeBunShim(
    'echo "FetchError: request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk timed out"\nexit 1',
  );
  const { status, output } = runAudit(binDir);
  assert.equal(status, 1);
  assert.match(output, /attempt 1\/3/);
  assert.match(output, /attempt 2\/3/);
  assert.match(output, /attempt 3\/3/);
  assert.match(
    output,
    /::error title=npm advisory endpoint outage::bun audit could not reach registry\.npmjs\.org\/-\/npm\/v1\/security\/advisories\/bulk after 3 attempts \(503\/timeout\)\. This is not a finding\. The osv-scanner job in this workflow is the second advisory feed; read it before treating this red as a vulnerability\./,
  );
});
