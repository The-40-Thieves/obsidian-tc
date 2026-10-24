// Tests for scripts/docker-boot-smoke.mjs. The banner parser/judge is pure, so these run with no
// docker; the real boot is ci-docker's job. The red cases are the verbatim banners from the
// published 1.32.0 image (vec=off, native=js-fallback) and the healthy shapes both transports print.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as smoke from "./docker-boot-smoke.mjs";
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

const HTTP_TEST_SERVER = String.raw`
const { createServer } = require("node:http");
const [port, status, behavior] = process.argv.slice(1);
const server = createServer((_request, response) => {
  if (behavior === "hang") return;
  response.writeHead(Number(status));
  response.end();
});
server.listen(Number(port), "127.0.0.1", () => {
  process.stdout.write(String(server.address().port) + "\n");
});
`;

function dockerHealthcheckScript() {
  const dockerfile = readFileSync(fileURLToPath(new URL("../Dockerfile", import.meta.url)), "utf8");
  const healthcheck = dockerfile.split("\n").find((line) => line.startsWith("HEALTHCHECK "));
  assert.ok(healthcheck, "missing HEALTHCHECK");
  const execForm = JSON.parse(healthcheck.slice(healthcheck.indexOf(" CMD ") + 5));
  assert.deepEqual(execForm.slice(0, 2), ["bun", "-e"]);
  return execForm[2];
}

function runHealthcheck(script, port) {
  const env = { ...process.env };
  if (port === undefined) delete env.PORT;
  else env.PORT = String(port);
  return spawnSync("bun", ["-e", script], {
    encoding: "utf8",
    env,
    timeout: 12_000,
  });
}

function runHealthcheckInIsolatedNetwork(script) {
  const env = { ...process.env };
  delete env.PORT;
  return spawnSync(
    "unshare",
    ["-Urn", "sh", "-c", 'ip link set lo up; exec bun -e "$1"', "healthcheck", script],
    { encoding: "utf8", env, timeout: 12_000 },
  );
}

async function unusedPort(preferred = 0) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(preferred, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function startHttpServer({ status = 200, behavior = "respond", port = 0 } = {}) {
  const child = spawn(
    process.execPath,
    ["-e", HTTP_TEST_SERVER, String(port), String(status), behavior],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const listeningPort = await new Promise((resolve, reject) => {
    const onExit = (code, signal) =>
      reject(new Error(`HTTP test server exited before listening (${code ?? signal}): ${stderr}`));
    child.once("error", reject);
    child.once("exit", onExit);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const lineEnd = stdout.indexOf("\n");
      if (lineEnd === -1) return;
      child.off("exit", onExit);
      resolve(Number(stdout.slice(0, lineEnd)));
    });
  });
  return {
    child,
    port: listeningPort,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

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

test("--mode selects the HTTP smoke while stdio remains the default", () => {
  assert.equal(parseArgs(["img"]).mode, "stdio");
  assert.equal(parseArgs(["img", "--mode", "http"]).mode, "http");
  assert.throws(() => parseArgs(["img", "--mode", "bogus"]), /--mode must be/);
});

test("HTTP health status accepts healthy and explains every non-ready state", () => {
  assert.deepEqual(smoke.checkHealthStatus("healthy"), []);
  assert.match(smoke.checkHealthStatus("unhealthy").join("\n"), /unhealthy/);
  assert.match(smoke.checkHealthStatus(undefined).join("\n"), /missing/i);
  assert.match(smoke.checkHealthStatus("starting", { timedOut: true }).join("\n"), /timed out/i);
});

test("list_vaults requires a successful MCP result that names main", () => {
  const good = { result: { structuredContent: { vaults: [{ id: "main" }] } } };
  assert.deepEqual(smoke.checkListVaultsResult(good), []);
  assert.match(
    smoke.checkListVaultsResult({ error: { code: -32603, message: "failed" } }).join("\n"),
    /MCP error/i,
  );
  assert.match(
    smoke
      .checkListVaultsResult({ result: { structuredContent: { vaults: [{ id: "other" }] } } })
      .join("\n"),
    /main/,
  );
});

test("image healthcheck keeps only an unconfigured refused stdio listener healthy", () => {
  const cases = [
    { portSet: true, outcome: "ok", healthy: true },
    { portSet: true, outcome: "refused", healthy: false },
    { portSet: false, outcome: "refused", healthy: true },
    { portSet: false, outcome: "http-503", healthy: false },
    { portSet: false, outcome: "timeout", healthy: false },
  ];
  for (const { portSet, outcome, healthy } of cases) {
    assert.equal(smoke.healthcheckDecision(portSet, outcome), healthy, `${portSet}/${outcome}`);
  }
});

test("healthcheck classifies Bun and Node connection-refused errors identically", () => {
  assert.equal(typeof smoke.classifyHealthcheckError, "function");
  const bunRefused = Object.assign(new TypeError("Unable to connect"), {
    code: "ConnectionRefused",
  });
  const nodeRefused = Object.assign(new TypeError("fetch failed"), {
    cause: { code: "ECONNREFUSED" },
  });
  assert.equal(smoke.classifyHealthcheckError(bunRefused), "refused");
  assert.equal(smoke.classifyHealthcheckError(nodeRefused), "refused");
  assert.equal(
    smoke.classifyHealthcheckError(new DOMException("aborted", "AbortError")),
    "timeout",
  );
  assert.equal(smoke.classifyHealthcheckError(new TypeError("other")), "error");
});

test("Dockerfile HEALTHCHECK executes the five listener outcomes", async (t) => {
  const script = dockerHealthcheckScript();

  await t.test("PORT unset and nothing listening exits 0", async (t) => {
    let run;
    try {
      await unusedPort(8765);
      run = runHealthcheck(script, undefined);
    } catch (error) {
      if (error?.code === "EADDRINUSE") {
        run = runHealthcheckInIsolatedNetwork(script);
        if (run.error?.code === "ENOENT" || /Operation not permitted/.test(run.stderr)) {
          t.skip(
            "host port 8765 is in use and an isolated loopback is unavailable; default is unchanged",
          );
          return;
        }
      } else {
        throw error;
      }
    }
    assert.equal(run.error, undefined, run.error?.message);
    assert.equal(run.status, 0, run.stderr);
  });

  await t.test("PORT set and nothing listening exits 1", async () => {
    const port = await unusedPort();
    const run = runHealthcheck(script, port);
    assert.equal(run.error, undefined, run.error?.message);
    assert.equal(run.status, 1, run.stderr);
  });

  await t.test("PORT set and /healthz answers 200 exits 0", async () => {
    const server = await startHttpServer({ status: 200 });
    try {
      const run = runHealthcheck(script, server.port);
      assert.equal(run.error, undefined, run.error?.message);
      assert.equal(run.status, 0, run.stderr);
    } finally {
      await server.stop();
    }
  });

  await t.test("PORT set and /healthz answers 503 exits 1", async () => {
    const server = await startHttpServer({ status: 503 });
    try {
      const run = runHealthcheck(script, server.port);
      assert.equal(run.error, undefined, run.error?.message);
      assert.equal(run.status, 1, run.stderr);
    } finally {
      await server.stop();
    }
  });

  await t.test("a server that never answers exits 1 within the probe abort window", async () => {
    const server = await startHttpServer({ behavior: "hang" });
    const startedAt = Date.now();
    try {
      const run = runHealthcheck(script, server.port);
      assert.equal(run.error, undefined, run.error?.message);
      assert.equal(run.status, 1, run.stderr);
      assert.ok(Date.now() - startedAt < 12_000, "probe exceeded its own abort window");
    } finally {
      await server.stop();
    }
  });
});

test("Dockerfile publishes the HTTP/data contract and pins the shared health rule", () => {
  const dockerfile = readFileSync(fileURLToPath(new URL("../Dockerfile", import.meta.url)), "utf8");
  assert.match(dockerfile, /^EXPOSE 8765$/m);
  assert.match(dockerfile, /^VOLUME (?:\["\/data"\]|\/data)$/m);
  assert.match(dockerfile, /mkdir -p \/data\/vault \/data\/cache/);
  assert.match(dockerfile, /chown -R bun:bun \/app \/data/);
  const healthcheck = dockerfile.split("\n").find((line) => line.startsWith("HEALTHCHECK "));
  assert.ok(healthcheck, "missing HEALTHCHECK");
  const cmd = healthcheck.slice(healthcheck.indexOf(" CMD ") + 5);
  const execForm = JSON.parse(cmd);
  assert.deepEqual(execForm.slice(0, 2), ["bun", "-e"]);
  const normalizedDecision = smoke.healthcheckDecision.toString().replace(/\s+/g, "");
  const expression = /^functionhealthcheckDecision\([^)]*\)\{return(.+);\}$/.exec(
    normalizedDecision,
  )?.[1];
  assert.ok(expression, "could not extract the healthcheck decision expression");
  assert.ok(execForm[2].includes(expression));
  assert.equal(typeof smoke.classifyHealthcheckError, "function");
  const normalizedClassifier = smoke.classifyHealthcheckError.toString().replace(/\s+/g, "");
  assert.ok(execForm[2].replace(/\s+/g, "").includes(normalizedClassifier));
  assert.match(dockerfile, /^ENTRYPOINT \["bun", "\/app\/packages\/server\/dist\/cli\.js"\]$/m);
});

test("Dockerfile -git target derives from the runtime stage; the untargeted build stays the runtime", () => {
  const dockerfile = readFileSync(fileURLToPath(new URL("../Dockerfile", import.meta.url)), "utf8");
  // The version itself is check-bun-version-coherence.mjs's job; this test pins the stage layout.
  assert.match(dockerfile, /^FROM oven\/bun:\d+\.\d+\.\d+-slim AS runtime$/m);
  assert.match(dockerfile, /^FROM runtime AS git$/m);
  // The last stage is the default build target: it must be the runtime image, not the -git variant.
  const fromLines = dockerfile.split("\n").filter((line) => /^FROM\s/.test(line));
  assert.equal(fromLines.at(-1), "FROM runtime");
  const git = dockerfile.slice(dockerfile.indexOf("FROM runtime AS git"));
  assert.match(git, /^USER root$/m);
  assert.match(git, /apt-get install -y --no-install-recommends git openssh-client tini/);
  assert.match(git, /^USER bun$/m);
  // tini is PID 1 so orphaned git and ssh children are reaped.
  assert.match(
    git,
    /^ENTRYPOINT \["\/usr\/bin\/tini", "--", "bun", "\/app\/packages\/server\/dist\/cli\.js", "git-sync", "--supervise"\]$/m,
  );
});
