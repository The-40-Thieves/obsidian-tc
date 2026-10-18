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
// --mode git boots the -git image (git-sync --supervise) against a bare repository it clones from,
// and drives both directions over MCP: a laptop push must reach read_note within a few pull
// intervals, and a write_note must land on the bare repository as a commit.
//
// Usage: node scripts/docker-boot-smoke.mjs <image> [--mode stdio|http|git]
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
  if (!["stdio", "http", "git"].includes(opts.mode)) {
    throw new Error(`--mode must be "stdio", "http" or "git", got "${opts.mode}"`);
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

const MCP_CLIENT = String.raw`
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
`;
const MCP_PROBE =
  MCP_CLIENT +
  `const result=await rpc(2,"tools/call",{name:"list_vaults",arguments:{}});
process.stdout.write(JSON.stringify(result));
`;
// One tools/call with the tool and its JSON arguments taken from the environment.
const MCP_TOOL_PROBE =
  MCP_CLIENT +
  `const result=await rpc(2,"tools/call",{name:process.env.OBSIDIAN_TC_SMOKE_TOOL,arguments:JSON.parse(process.env.OBSIDIAN_TC_SMOKE_ARGS)});
process.stdout.write(JSON.stringify(result));
`;

// Git mode helpers. The laptop is a clone on the runner; the container's vault is a clone of the
// bare repository, which the container reaches through the file:// transport.
const GIT_ENV = {
  OBSIDIAN_TC_VAULT_GIT_URL: "file:///remote/vault.git",
  OBSIDIAN_TC_VAULT_GIT_BRANCH: "main",
  OBSIDIAN_TC_VAULT_GIT_AUTHOR: "Vault Bot <vault@example.test>",
  OBSIDIAN_TC_VAULT_GIT_PULL_INTERVAL: "10",
  OBSIDIAN_TC_VAULT_GIT_PUSH: "batched",
};

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pollUntil(check, limitMs, intervalMs = 1000) {
  const deadline = Date.now() + limitMs;
  for (;;) {
    if (check()) return true;
    if (Date.now() >= deadline) return false;
    sleepMs(intervalMs);
  }
}

// Git identity for the laptop's commits. The laptop runs in a container, not on the runner: see workRun.
const LAPTOP_GIT =
  "git -c user.name=laptop -c user.email=laptop@example.test -c commit.gpgsign=false";

/**
 * Runs a shell script in the image as uid 1000, with the work directory mounted at /work. Every
 * write to the bare repository and the laptop clone goes through here: the container's git-sync runs
 * as uid 1000, git refuses a repository owned by another uid, and the runner cannot write into a
 * tree that uid owns. Reads of the bare repository from the runner are fine.
 */
function workRun(image, platform, root, script, user = "1000:1000") {
  return spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--user",
      user,
      "--entrypoint",
      "sh",
      ...(platform ? ["--platform", platform] : []),
      "--mount",
      `type=bind,src=${root},dst=/work`,
      image,
      "-c",
      script,
    ],
    { encoding: "utf8", timeout: 120_000 },
  );
}

function mcpCall(name, token, tool, args) {
  return spawnSync(
    "docker",
    [
      "exec",
      "-e",
      "OBSIDIAN_TC_SMOKE_TOKEN",
      "-e",
      "OBSIDIAN_TC_SMOKE_TOOL",
      "-e",
      "OBSIDIAN_TC_SMOKE_ARGS",
      name,
      "bun",
      "-e",
      MCP_TOOL_PROBE,
    ],
    {
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        OBSIDIAN_TC_SMOKE_TOKEN: token,
        OBSIDIAN_TC_SMOKE_TOOL: tool,
        OBSIDIAN_TC_SMOKE_ARGS: JSON.stringify(args),
      },
    },
  );
}

/**
 * Creates the bare repository the container syncs with, seeded with hello.md from a laptop clone.
 * Everything is created as uid 1000 (the work directory is chowned to it first, as root).
 */
function prepareGitRemote(root, id, image, platform) {
  // mkdtemp makes the work directory 0700: open it to the runner again so it can read the remote.
  const owned = workRun(
    image,
    platform,
    root,
    "chown -R 1000:1000 /work && chmod 0755 /work",
    "0:0",
  );
  const chown = commandProblems("chown of the work directory", owned);
  if (chown.length > 0) return { problems: chown };
  const seed = workRun(
    image,
    platform,
    root,
    [
      "set -eu",
      "cd /work",
      "git init -q --bare --initial-branch=main vault.git",
      "git init -q --initial-branch=main laptop",
      `echo seed-${id} > laptop/hello.md`,
      "cd laptop",
      "git remote add origin /work/vault.git",
      "git add hello.md",
      `${LAPTOP_GIT} commit -qm seed`,
      "git push -q origin main",
    ].join("\n"),
  );
  return {
    remote: join(root, "vault.git"),
    problems: commandProblems("seeding the bare repository", seed),
  };
}

/** The laptop-to-container and container-to-remote checks; problems are empty when both pass. */
function gitSyncProbes({ name, token, id, image, platform, root, remote }) {
  const readNote = (path) =>
    String(mcpCall(name, token, "read_note", { vault: "main", path }).stdout ?? "");
  if (!pollUntil(() => readNote("hello.md").includes(`seed-${id}`), 60_000)) {
    return ["the seed commit never reached read_note"];
  }
  const push = workRun(
    image,
    platform,
    root,
    [
      "set -eu",
      "cd /work/laptop",
      `echo laptop-${id} > hello.md`,
      `${LAPTOP_GIT} commit -qam "laptop change"`,
      "git push -q origin main",
    ].join("\n"),
  );
  const problems = commandProblems("laptop commit and push", push);
  if (problems.length > 0) return problems;
  // Three pull intervals (10 s each) plus slack for the boot and the pull itself.
  if (!pollUntil(() => readNote("hello.md").includes(`laptop-${id}`), 90_000)) {
    problems.push("a laptop push to hello.md did not reach read_note within 90 s");
  }
  const note = `written-${id}\n`;
  const write = mcpCall(name, token, "write_note", {
    vault: "main",
    path: "new.md",
    content: note,
  });
  problems.push(...commandProblems("write_note new.md over /mcp", write));
  if (/"isError":true/.test(String(write.stdout ?? ""))) {
    problems.push(`write_note new.md was refused: ${String(write.stdout).slice(0, 500)}`);
  }
  // The batch waits 10 s of quiet (60 s at most) before it commits; allow that plus a pull.
  let seen;
  const landed = () => {
    seen = spawnSync(
      "git",
      ["-c", "safe.directory=*", "--git-dir", remote, "show", "main:new.md"],
      {
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    return seen.status === 0 && seen.stdout === note;
  };
  if (!pollUntil(landed, 150_000)) {
    const detail = `status=${seen?.status} stdout=${JSON.stringify(seen?.stdout ?? "").slice(0, 200)} stderr=${String(
      seen?.stderr ?? "",
    )
      .trim()
      .slice(0, 300)}`;
    problems.push(
      `write_note new.md did not land on the bare repository as a commit within 150 s (${detail})`,
    );
  }
  return problems;
}

/** Secret-looking material in the container log is a failure: the log leaves the box in CI. */
function secretProblems(output, secrets) {
  const problems = [];
  if (secrets.some((secret) => secret && output.includes(secret))) {
    problems.push("container log contains the JWT signing key or a minted token");
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(output)) {
    problems.push("container log contains a private key");
  }
  if (/[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i.test(output)) {
    problems.push("container log contains a URL with embedded credentials");
  }
  return problems;
}

function runHttp(opts) {
  const gitMode = opts.mode === "git";
  const root = mkdtempSync(join(tmpdir(), "otc-http-boot-smoke-"));
  const vault = join(root, "vault");
  mkdirSync(vault);
  chmodSync(vault, 0o777);
  writeFileSync(join(vault, "hello.md"), "# Hello\n\nHTTP boot smoke note\n", { mode: 0o644 });
  const configDir = fileURLToPath(new URL("../deploy/config", import.meta.url));
  const id = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const name = `otc-http-boot-smoke-${id}`;
  const volume = `otc-http-boot-smoke-data-${id}`;
  const gitEnv = gitMode ? GIT_ENV : {};
  const containerEnv = {
    ...process.env,
    OBSIDIAN_TC_CONFIG: "/config/obsidian-tc.config.json",
    OBSIDIAN_TC_VAULT_PATH: "/data/vault",
    OBSIDIAN_TC_CACHE_DIR: "/data/cache",
    PORT: "8765",
    OBSIDIAN_TC_PUBLIC_URL: "https://vault.example.com",
    OBSIDIAN_TC_JWT_SECRET: randomBytes(32).toString("base64url"),
    ...gitEnv,
  };
  const envNames = [
    "OBSIDIAN_TC_CONFIG",
    "OBSIDIAN_TC_VAULT_PATH",
    "OBSIDIAN_TC_CACHE_DIR",
    "PORT",
    "OBSIDIAN_TC_PUBLIC_URL",
    "OBSIDIAN_TC_JWT_SECRET",
    ...Object.keys(gitEnv),
  ];
  const problems = [];
  let output = "";
  try {
    const gitRemote = gitMode ? prepareGitRemote(root, id, opts.image, opts.platform) : undefined;
    problems.push(...(gitRemote?.problems ?? []));
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
          ...(gitMode
            ? ["--mount", `type=bind,src=${gitRemote.remote},dst=/remote/vault.git`]
            : ["--mount", `type=bind,src=${vault},dst=/data/vault,readonly`]),
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
          gitMode ? "read:vault,read:notes,write:notes" : "read:vault",
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

    if (gitMode && problems.length === 0) {
      problems.push(
        ...gitSyncProbes({
          name,
          token,
          id,
          image: opts.image,
          platform: opts.platform,
          root,
          remote: gitRemote.remote,
        }),
      );
    }

    const logs = spawnSync("docker", ["logs", name], {
      encoding: "utf8",
      timeout: opts.timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    problems.push(...commandProblems("docker logs", logs));
    output = `${logs.stdout ?? ""}${logs.stderr ?? ""}`;
    problems.push(...checkBoot(output, { expectNative: opts.expectNative }));
    if (gitMode) problems.push(...secretProblems(output, [containerEnv.OBSIDIAN_TC_JWT_SECRET]));
    const banner = parseReadyBanner(output);
    process.stdout.write(`${banner ? banner.line : output.slice(-2000)}\n`);

    for (const problem of problems)
      process.stderr.write(`::error::docker HTTP smoke: ${problem}\n`);
    if (gitMode && problems.length > 0) process.stderr.write(`${output.slice(-8000)}\n`);
    if (problems.length === 0) {
      process.stdout.write(
        `ok: ${opts.image}${opts.platform ? ` (${opts.platform})` : ""} ${gitMode ? "synced the vault over git and served" : "served"} authenticated MCP over HTTP with native=${banner.native} vec=${banner.vec}\n`,
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
    if (gitMode)
      workRun(
        opts.image,
        opts.platform,
        root,
        `chown -R ${process.getuid()}:${process.getgid()} /work`,
        "0:0",
      );
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
  return opts.mode === "stdio" ? runStdio(opts) : runHttp(opts);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
