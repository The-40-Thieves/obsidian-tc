#!/usr/bin/env node
// docker-boot-smoke: boot a built obsidian-tc image with NO network and assert what its ready
// banner says about the optional native pieces.
//
// Why this exists: `native` and `vec` are both optional at run time. The server loads the napi
// module and the sqlite-vec extension through createRequire() and, when either is absent, carries
// on with the pure-JS fallback / brute-force cosine scan. So an image that lost sqlite-vec still
// builds, still answers `version`, still resolves @redis/client and still boots; the only trace is
// the last word of the ready banner. The published 1.32.0 image shipped exactly that:
//
//   obsidian-tc 1.32.0 ready (http-only; stdio disabled; vault agents; native=js-fallback vec=off)
//
// (its node_modules held only @redis/client's tree, which switched Bun's runtime auto-install off,
// and auto-install was the only thing that had ever provided sqlite-vec). ci-docker's `version`
// and @redis/client smokes cannot see that, so this one reads the banner.
//
// `--network none` is the point: the packages must be IN the image. Anything that only works
// because the container can reach the npm registry fails here.
//
// The banner is necessary but not sufficient: `docker run` itself has to succeed too. A container
// that prints a healthy banner and then crashes, is killed, or hangs until the timeout is not a
// pass, so the run's error / signal / exit status are judged alongside the banner.
//
// --platform boots a specific platform of a multi-arch image (publish.yml and release-image.yml
// smoke linux/amd64 and linux/arm64 of the exact image they are about to promote).
//
// Usage: node scripts/docker-boot-smoke.mjs <image> [--mode stdio|http]
//        [--expect-native on|js-fallback] [--platform linux/amd64|linux/arm64] [--timeout-ms N]
// Exit: 0 healthy; 1 banner reports a degraded capability or the run did not exit cleanly;
//       2 no banner (boot failed).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The stdio and http-only banners differ in the middle ("ready on stdio (vault x; ..." vs
// "ready (http-only; stdio disabled; vault x; ..."), so anchor on the tail both share.
const BANNER = /obsidian-tc (\S+) ready\b.*\bnative=(on|js-fallback) vec=(on|off)\)/;

/** Parse the server's ready banner out of captured container output; null when there is none. */
export function parseReadyBanner(output) {
  const m = BANNER.exec(output);
  return m ? { line: m[0], version: m[1], native: m[2], vec: m[3] } : null;
}

/** Problems (empty = healthy) for a captured boot against the expected capabilities. */
export function checkBoot(output, { expectNative = "on" } = {}) {
  const banner = parseReadyBanner(output);
  if (!banner) return ["no ready banner in the container output (did the server boot?)"];
  const problems = [];
  if (banner.vec !== "on") {
    problems.push(
      `vec=${banner.vec}: sqlite-vec did not load, dense retrieval falls back to the brute-force scan`,
    );
  }
  if (banner.native !== expectNative) {
    problems.push(`native=${banner.native}, expected native=${expectNative}`);
  }
  return problems;
}

/**
 * Problems (empty = clean) with the `docker run` process itself, from a spawnSync result:
 * a start failure or timeout (`error`), a kill (`signal`), or a non-zero exit (`status`).
 */
export function checkRun(run) {
  const problems = [];
  if (run.error) {
    const code = run.error.code ? ` ${run.error.code}` : "";
    problems.push(`docker run did not complete:${code} ${run.error.message}`.replace(/\s+/g, " "));
  }
  if (run.signal) problems.push(`docker run was killed by ${run.signal}`);
  if (!run.error && !run.signal && run.status !== 0) {
    problems.push(`docker run exited with status ${run.status}, expected 0`);
  }
  return problems;
}

/** Problems (empty = ready or still starting) reported by Docker's image health state. */
export function checkHealthStatus(status, { timedOut = false } = {}) {
  if (status === "healthy") return [];
  if (timedOut) return [`health check timed out while status was ${status ?? "missing"}`];
  if (status === "starting") return [];
  if (status === undefined || status === null || status === "missing" || status === "") {
    return ["missing Docker health status (the image HEALTHCHECK may be absent)"];
  }
  return [`Docker health status is ${status}`];
}

/** Problems (empty = good) with the authenticated list_vaults JSON-RPC response. */
export function checkListVaultsResult(message) {
  if (message?.error) return [`MCP error from list_vaults: ${JSON.stringify(message.error)}`];
  const vaults = message?.result?.structuredContent?.vaults;
  if (!Array.isArray(vaults)) return ["list_vaults result has no structuredContent.vaults array"];
  if (!vaults.some((vault) => vault?.id === "main")) {
    return ['list_vaults result does not name the configured vault "main"'];
  }
  return [];
}

// The Dockerfile contract test derives the normalized expression from this function and requires
// the exec-form HEALTHCHECK to contain it. That keeps this as the single decision rule: 200 is
// always healthy; connection-refused is healthy only for a stdio session with PORT absent.
export function healthcheckDecision(portSet, outcome) {
  return outcome === "ok" || (!portSet && outcome === "refused");
}

/** Map the error shapes emitted by Bun and Node fetch to the image healthcheck outcome. */
export function classifyHealthcheckError(error) {
  const code = error?.cause?.code ?? error?.code;
  return code === "ConnectionRefused" || code === "ECONNREFUSED"
    ? "refused"
    : error?.name === "AbortError"
      ? "timeout"
      : "error";
}

export function parseArgs(argv) {
  const opts = {
    image: undefined,
    mode: "stdio",
    expectNative: "on",
    platform: undefined,
    timeoutMs: 120_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--expect-native") opts.expectNative = argv[++i];
    else if (a === "--mode") opts.mode = argv[++i];
    else if (a === "--platform") opts.platform = argv[++i];
    else if (a === "--timeout-ms") opts.timeoutMs = Number(argv[++i]);
    else if (a?.startsWith("-")) throw new Error(`unknown option ${a}`);
    else opts.image = a;
  }
  if (!opts.image)
    throw new Error("usage: docker-boot-smoke.mjs <image> [--expect-native on|js-fallback]");
  if (!["on", "js-fallback"].includes(opts.expectNative)) {
    throw new Error(`--expect-native must be "on" or "js-fallback", got "${opts.expectNative}"`);
  }
  if (!["stdio", "http"].includes(opts.mode)) {
    throw new Error(`--mode must be "stdio" or "http", got "${opts.mode}"`);
  }
  if (opts.platform !== undefined && !/^linux\/(amd64|arm64)$/.test(opts.platform)) {
    throw new Error(`--platform must be linux/amd64 or linux/arm64, got "${opts.platform}"`);
  }
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) throw new Error("bad --timeout-ms");
  return opts;
}

function runStdio(opts) {
  // The container runs as uid 1000, which is not the runner's uid: make the vault world-readable.
  const vault = mkdtempSync(join(tmpdir(), "otc-boot-smoke-"));
  chmodSync(vault, 0o777);
  writeFileSync(join(vault, "hello.md"), "# Hello\n\nboot smoke note\n", { mode: 0o644 });
  const name = `otc-boot-smoke-${process.pid}`;
  try {
    // Zero-config boot (vault folder as the only argument). No -i: stdin is /dev/null, the stdio
    // transport sees EOF and the process exits on its own right after printing the banner.
    const run = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--name",
        name,
        ...(opts.platform ? ["--platform", opts.platform] : []),
        "--network",
        "none",
        "-v",
        `${vault}:/vault`,
        opts.image,
        "/vault",
      ],
      { encoding: "utf8", timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024 },
    );
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    const banner = parseReadyBanner(output);
    process.stdout.write(`${banner ? banner.line : output.slice(-2000)}\n`);
    const problems = [...checkRun(run), ...checkBoot(output, { expectNative: opts.expectNative })];
    for (const p of problems) process.stderr.write(`::error::docker boot smoke: ${p}\n`);
    if (problems.length === 0) {
      process.stdout.write(
        `ok: ${opts.image}${opts.platform ? ` (${opts.platform})` : ""} booted offline with native=${banner.native} vec=${banner.vec}\n`,
      );
      return 0;
    }
    return banner ? 1 : 2;
  } finally {
    spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    rmSync(vault, { recursive: true, force: true });
  }
}

function commandProblems(label, run) {
  const problems = [];
  if (run.error) {
    const code = run.error.code ? ` ${run.error.code}` : "";
    problems.push(`${label} failed:${code} ${run.error.message}`.replace(/\s+/g, " "));
  }
  if (run.signal) problems.push(`${label} was killed by ${run.signal}`);
  if (!run.error && !run.signal && run.status !== 0) {
    const detail = String(run.stderr ?? "").trim();
    problems.push(`${label} exited with status ${run.status}${detail ? `: ${detail}` : ""}`);
  }
  return problems;
}

function waitForHealthy(name, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let status;
  while (Date.now() < deadline) {
    const inspect = spawnSync(
      "docker",
      [
        "inspect",
        "--format",
        "{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}",
        name,
      ],
      { encoding: "utf8" },
    );
    const command = commandProblems("docker inspect health", inspect);
    if (command.length > 0) return { status, problems: command };
    status = inspect.stdout.trim();
    if (status === "healthy") return { status, problems: [] };
    const stateProblems = checkHealthStatus(status);
    if (stateProblems.length > 0) return { status, problems: stateProblems };
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  return { status, problems: checkHealthStatus(status, { timedOut: true }) };
}

const HEALTHZ_PROBE =
  'const r=await fetch("http://127.0.0.1:8765/healthz");const b=await r.json();if(r.status!==200||b.status!=="ok")throw new Error("healthz "+r.status+": "+JSON.stringify(b))';

const MCP_PROBE = String.raw`
const token=process.env.OBSIDIAN_TC_SMOKE_TOKEN;
if(!token)throw new Error("missing smoke token");
const version="2025-11-25";
async function rpc(id,method,params){
  const r=await fetch("http://127.0.0.1:8765/mcp",{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json",accept:"application/json, text/event-stream","mcp-protocol-version":version},body:JSON.stringify({jsonrpc:"2.0",id,method,...(params?{params}:{})})});
  const text=await r.text();
  const line=text.split("\n").find((value)=>value.startsWith("data: "));
  const message=JSON.parse(line?line.slice(6):text);
  if(r.status!==200||message.error)throw new Error(method+" failed ("+r.status+"): "+JSON.stringify(message.error??message));
  return message;
}
await rpc(1,"initialize",{protocolVersion:version,capabilities:{},clientInfo:{name:"docker-boot-smoke",version:"1"}});
const result=await rpc(2,"tools/call",{name:"list_vaults",arguments:{}});
process.stdout.write(JSON.stringify(result));
`;

function runHttp(opts) {
  const root = mkdtempSync(join(tmpdir(), "otc-http-boot-smoke-"));
  const vault = join(root, "vault");
  mkdirSync(vault);
  chmodSync(vault, 0o777);
  writeFileSync(join(vault, "hello.md"), "# Hello\n\nHTTP boot smoke note\n", { mode: 0o644 });
  const configDir = fileURLToPath(new URL("../deploy/config", import.meta.url));
  const id = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const name = `otc-http-boot-smoke-${id}`;
  const volume = `otc-http-boot-smoke-data-${id}`;
  const containerEnv = {
    ...process.env,
    OBSIDIAN_TC_CONFIG: "/config/obsidian-tc.config.json",
    OBSIDIAN_TC_VAULT_PATH: "/data/vault",
    OBSIDIAN_TC_CACHE_DIR: "/data/cache",
    PORT: "8765",
    OBSIDIAN_TC_PUBLIC_URL: "https://vault.example.com",
    OBSIDIAN_TC_JWT_SECRET: randomBytes(32).toString("base64url"),
  };
  const envNames = [
    "OBSIDIAN_TC_CONFIG",
    "OBSIDIAN_TC_VAULT_PATH",
    "OBSIDIAN_TC_CACHE_DIR",
    "PORT",
    "OBSIDIAN_TC_PUBLIC_URL",
    "OBSIDIAN_TC_JWT_SECRET",
  ];
  const problems = [];
  let output = "";
  try {
    const createVolume = spawnSync("docker", ["volume", "create", volume], {
      encoding: "utf8",
      timeout: opts.timeoutMs,
    });
    problems.push(...commandProblems("docker volume create", createVolume));

    if (problems.length === 0) {
      const run = spawnSync(
        "docker",
        [
          "run",
          "-d",
          "--name",
          name,
          ...(opts.platform ? ["--platform", opts.platform] : []),
          "--network",
          "none",
          "--mount",
          `type=volume,src=${volume},dst=/data`,
          "--mount",
          `type=bind,src=${vault},dst=/data/vault,readonly`,
          "-v",
          `${configDir}:/config:ro`,
          ...envNames.flatMap((envName) => ["-e", envName]),
          opts.image,
        ],
        {
          encoding: "utf8",
          timeout: opts.timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
          env: containerEnv,
        },
      );
      problems.push(...checkRun(run));
    }

    if (problems.length === 0) {
      const health = waitForHealthy(name, opts.timeoutMs);
      problems.push(...health.problems);
    }

    if (problems.length === 0) {
      const healthz = spawnSync("docker", ["exec", name, "bun", "-e", HEALTHZ_PROBE], {
        encoding: "utf8",
        timeout: opts.timeoutMs,
      });
      problems.push(...commandProblems("in-container /healthz probe", healthz));
    }

    let token = "";
    if (problems.length === 0) {
      const mint = spawnSync(
        "docker",
        [
          "exec",
          name,
          "bun",
          "/app/packages/server/dist/cli.js",
          "token",
          "mint",
          "/config/obsidian-tc.config.json",
          "--sub",
          "docker-boot-smoke",
          "--vault",
          "main",
          "--scopes",
          "read:vault",
        ],
        { encoding: "utf8", timeout: opts.timeoutMs },
      );
      problems.push(...commandProblems("token mint", mint));
      if (problems.length === 0) token = mint.stdout.trim();
    }

    if (problems.length === 0) {
      const mcp = spawnSync(
        "docker",
        ["exec", "-e", "OBSIDIAN_TC_SMOKE_TOKEN", name, "bun", "-e", MCP_PROBE],
        {
          encoding: "utf8",
          timeout: opts.timeoutMs,
          env: { ...process.env, OBSIDIAN_TC_SMOKE_TOKEN: token },
        },
      );
      problems.push(...commandProblems("authenticated list_vaults probe", mcp));
      if (problems.length === 0) {
        try {
          problems.push(...checkListVaultsResult(JSON.parse(mcp.stdout)));
        } catch (error) {
          problems.push(`list_vaults probe returned invalid JSON: ${error.message}`);
        }
      }
    }

    const logs = spawnSync("docker", ["logs", name], {
      encoding: "utf8",
      timeout: opts.timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    problems.push(...commandProblems("docker logs", logs));
    output = `${logs.stdout ?? ""}${logs.stderr ?? ""}`;
    problems.push(...checkBoot(output, { expectNative: opts.expectNative }));
    const banner = parseReadyBanner(output);
    process.stdout.write(`${banner ? banner.line : output.slice(-2000)}\n`);

    for (const problem of problems)
      process.stderr.write(`::error::docker HTTP smoke: ${problem}\n`);
    if (problems.length === 0) {
      process.stdout.write(
        `ok: ${opts.image}${opts.platform ? ` (${opts.platform})` : ""} served authenticated MCP over HTTP with native=${banner.native} vec=${banner.vec}\n`,
      );
      return 0;
    }
    return banner ? 1 : 2;
  } finally {
    const removeContainer = spawnSync("docker", ["rm", "-f", name], { encoding: "utf8" });
    for (const problem of commandProblems("docker container cleanup", removeContainer)) {
      process.stderr.write(`::warning::docker HTTP smoke: ${problem}\n`);
    }
    const removeVolume = spawnSync("docker", ["volume", "rm", "-f", volume], {
      encoding: "utf8",
    });
    for (const problem of commandProblems("docker volume cleanup", removeVolume)) {
      process.stderr.write(`::warning::docker HTTP smoke: ${problem}\n`);
    }
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      process.stderr.write(
        `::warning::docker HTTP smoke: temporary directory cleanup failed: ${error.message}\n`,
      );
    }
  }
}

function main(argv) {
  const opts = parseArgs(argv);
  return opts.mode === "http" ? runHttp(opts) : runStdio(opts);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
