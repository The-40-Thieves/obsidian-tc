// Tests for scripts/docker-boot-smoke.mjs. The banner parser/judge is pure, so these run with no
// docker; the real boot is ci-docker's job. The red cases are the verbatim banners from the
// published 1.32.0 image (vec=off, native=js-fallback) and the healthy shapes both transports print.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkBoot, checkRun, parseArgs, parseReadyBanner } from "./docker-boot-smoke.mjs";

const HTTP_ONLY_1_32_0 =
  "obsidian-tc 1.32.0 ready (http-only; stdio disabled; vault agents; native=js-fallback vec=off)";
const STDIO_DEGRADED = "obsidian-tc 1.32.0 ready on stdio (vault main; native=js-fallback vec=off)";
const HTTP_HEALTHY =
  "obsidian-tc 1.33.0 ready (http-only; stdio disabled; vault agents; native=on vec=on)";
const STDIO_HEALTHY = "obsidian-tc 1.33.0 ready on stdio (vault main; native=on vec=on)";
const NOISE = [
  'reranker "local": bare-specifier did not resolve',
  "security: profile=trusted-local auth=none",
].join("\n");

test("the 1.32.0 http-only banner (vec=off, native=js-fallback) fails on both counts", () => {
  const problems = checkBoot(`${NOISE}\n${HTTP_ONLY_1_32_0}\n`);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /vec=off/);
  assert.match(problems[1], /native=js-fallback, expected native=on/);
});

test("the 1.32.0 stdio banner fails too (the transport must not matter)", () => {
  assert.equal(checkBoot(STDIO_DEGRADED).length, 2);
});

test("vec=off alone fails even when the native module loaded", () => {
  const problems = checkBoot("obsidian-tc 1.33.0 ready on stdio (vault main; native=on vec=off)");
  assert.equal(problems.length, 1);
  assert.match(problems[0], /vec=off/);
});

test("both healthy banners pass", () => {
  assert.deepEqual(checkBoot(`${NOISE}\n${HTTP_HEALTHY}\n`), []);
  assert.deepEqual(checkBoot(`${NOISE}\n${STDIO_HEALTHY}\n`), []);
});

test("--expect-native js-fallback accepts the fallback but still demands vec=on", () => {
  const fallbackOk = "obsidian-tc 1.33.0 ready on stdio (vault main; native=js-fallback vec=on)";
  assert.deepEqual(checkBoot(fallbackOk, { expectNative: "js-fallback" }), []);
  assert.equal(checkBoot(STDIO_HEALTHY, { expectNative: "js-fallback" }).length, 1);
});

test("output with no ready banner is a failure, not a pass", () => {
  assert.equal(parseReadyBanner(NOISE), null);
  assert.deepEqual(checkBoot(""), [
    "no ready banner in the container output (did the server boot?)",
  ]);
  // the shutdown line shares the "obsidian-tc:" prefix but is not a ready banner
  assert.equal(checkBoot("obsidian-tc: shutting down (transport:stdio-eof)").length, 1);
});

test("parseReadyBanner extracts version and both capability flags", () => {
  assert.deepEqual(parseReadyBanner(HTTP_ONLY_1_32_0), {
    line: HTTP_ONLY_1_32_0,
    version: "1.32.0",
    native: "js-fallback",
    vec: "off",
  });
});

// `docker run` itself must have succeeded: a healthy banner followed by a crash, a kill or a
// timeout is not a pass. spawnSync reports a timeout as error=ETIMEDOUT + signal=SIGTERM +
// status=null, a failure to start docker as error=ENOENT, a container crash as status!=0.
test("a clean exit (status 0, no error, no signal) passes", () => {
  assert.deepEqual(checkRun({ status: 0, signal: null, error: undefined }), []);
});

test("a timeout fails even though the banner printed before the hang", () => {
  const run = {
    status: null,
    signal: "SIGTERM",
    error: Object.assign(new Error("spawnSync docker ETIMEDOUT"), { code: "ETIMEDOUT" }),
    stdout: HTTP_HEALTHY,
  };
  const problems = checkRun(run);
  assert.ok(problems.length >= 1);
  assert.match(problems.join("\n"), /ETIMEDOUT/);
});

test("docker failing to start (run.error) fails", () => {
  const run = {
    status: null,
    signal: null,
    error: Object.assign(new Error("spawnSync docker ENOENT"), { code: "ENOENT" }),
  };
  assert.match(checkRun(run).join("\n"), /ENOENT/);
});

test("a container killed by a signal fails", () => {
  const problems = checkRun({ status: null, signal: "SIGKILL" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /SIGKILL/);
});

test("a non-zero exit fails even with a healthy banner on stdout", () => {
  const problems = checkRun({ status: 137, signal: null, stdout: STDIO_HEALTHY });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /status 137/);
  assert.deepEqual(checkBoot(STDIO_HEALTHY), []);
});

test("--platform is parsed and validated", () => {
  assert.equal(parseArgs(["img", "--platform", "linux/arm64"]).platform, "linux/arm64");
  assert.equal(parseArgs(["img"]).platform, undefined);
  assert.throws(() => parseArgs(["img", "--platform", "windows/amd64"]), /--platform must be/);
});
