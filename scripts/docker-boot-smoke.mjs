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
// Usage: node scripts/docker-boot-smoke.mjs <image> [--expect-native on|js-fallback]
//        [--timeout-ms N]
// Exit: 0 banner matches; 1 banner reports a degraded capability; 2 no banner (boot failed).
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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

function parseArgs(argv) {
  const opts = { image: undefined, expectNative: "on", timeoutMs: 120_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--expect-native") opts.expectNative = argv[++i];
    else if (a === "--timeout-ms") opts.timeoutMs = Number(argv[++i]);
    else if (a?.startsWith("-")) throw new Error(`unknown option ${a}`);
    else opts.image = a;
  }
  if (!opts.image)
    throw new Error("usage: docker-boot-smoke.mjs <image> [--expect-native on|js-fallback]");
  if (!["on", "js-fallback"].includes(opts.expectNative)) {
    throw new Error(`--expect-native must be "on" or "js-fallback", got "${opts.expectNative}"`);
  }
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) throw new Error("bad --timeout-ms");
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
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
    const problems = checkBoot(output, { expectNative: opts.expectNative });
    for (const p of problems) process.stderr.write(`::error::docker boot smoke: ${p}\n`);
    if (problems.length === 0) {
      process.stdout.write(
        `ok: ${opts.image} booted offline with native=${banner.native} vec=${banner.vec}\n`,
      );
      return 0;
    }
    return banner ? 1 : 2;
  } finally {
    spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    rmSync(vault, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
