#!/usr/bin/env node
// publish-smithery (THE-956) — every other directory listing updates itself on a version tag
// (the MCP Registry via `publish-registry`, the un-prefixed plugin release via
// mirror-plugin-release.mjs); Smithery was the one surface still needing a human hand. On
// 2026-09-05 the 1.27.0 listing was published from Cave by hand: `smithery mcp publish
// ./obsidian-tc.mcpb -n the-40-thieves/obsidian-tc`, using SMITHERY_API_KEY (the CLI's browser
// login expires in ~5 minutes, so only the key path suits CI). This script makes that call from
// `publish.yml`.
//
// The external command (`smithery`) goes through an injectable `runner` so tests can fake it with
// no subprocess, no network, and no real key — mirrors mirror-plugin-release.mjs's shape.
//
// Never logs a secret: SMITHERY_API_KEY is read only to check it's non-empty, then reaches the
// child process solely through its INHERITED environment (execFileSync inherits process.env by
// default) — it is never appended to argv, so it can never appear in a process listing, a crash's
// argv dump, or anything this script prints.
//
// Prereleases (a version containing "-", e.g. 1.28.0-rc.1) are skipped outright: the live
// Smithery listing (`mcpUrl`) is what users actually hit, so an RC must never be deployed there.
// This is a TRUE no-op, checked before even the SMITHERY_API_KEY presence check — mirrored by the
// same prerelease gate at the workflow-step level (publish.yml), so the guard holds even if a
// caller invokes this script directly.
//
// Dry-run performs no call at all here (there is nothing to read before publishing, unlike
// mirror-plugin-release.mjs's classification reads) — it just prints the command it would run.
//
// No idempotency preflight, unlike this repo's other publish jobs (publish-npm's F3,
// publish-registry's exact-match GET): probed live 2026-09-05 against the already-published
// 1.27.0 bundle (task-5-report.md) and a REPEAT publish of an already-listed version is not an
// error — Smithery accepts it as a new release (`status: SUCCESS`, a fresh `deploymentId`) and
// redeploys the hosted `mcpUrl`. So a re-run of this job is safe by construction; there is no
// "duplicate/already published" response for this script to special-case, because none exists —
// an earlier revision carried a defensive branch for one anyway and its own live probe evidence
// showed nothing could ever reach it, so per review it was removed rather than kept as untested,
// unreachable code (fix round 1, task-5-review.md finding 1).
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// The org's Smithery namespace, confirmed 2026-09-05 against the live registry — the 1.27.0
// listing already published under it by hand (see
// docs/superpowers/plans/2026-09-03-listings/smithery.md). A constant, not derived from
// server.json/package.json: Smithery's qualified name is an org-controlled slug on Smithery's own
// side, unrelated to this repo's own package/server names.
export const SMITHERY_NAME = "the-40-thieves/obsidian-tc";

/** execFileSync wrapper — shell-free (argv array, no interpolation) and swappable in tests. */
export function defaultRunner(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8" });
}

export function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--bundle") args.bundle = argv[++i];
    else if (a === "--version") args.version = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else throw new Error(`publish-smithery: unrecognized argument: ${a}`);
  }
  for (const [key, flag] of Object.entries({ bundle: "--bundle", version: "--version" })) {
    if (!args[key]) throw new Error(`publish-smithery: ${flag} is required`);
  }
  return args;
}

/** A prerelease version (e.g. "1.28.0-rc.1") contains a "-" per semver; a stable one never does. */
export function isPrerelease(version) {
  return version.includes("-");
}

/**
 * Parses the CLI's own JSON status line out of its combined stdio. `smithery mcp publish` prints
 * human progress lines ("Publishing ... to Smithery Registry...", "✓ Release ... accepted")
 * before the single JSON object this script cares about
 * (`{"deploymentId","qualifiedName","status","mcpUrl","statusUrl"}` — confirmed live 2026-09-05,
 * see task-5-report.md). Scans from the end so a `{`-looking substring in the progress text above
 * it is never mistaken for the real line.
 */
export function parsePublishOutput(output) {
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("{")) {
      try {
        return JSON.parse(lines[i]);
      } catch {
        // Not JSON after all (a progress line that happens to start with '{') — keep scanning.
      }
    }
  }
  return null;
}

/**
 * Classifies one publish attempt, pure and injectable so it's testable with no subprocess.
 * Returns `{ ok, message }`. SUCCESS is the only passing status — no "duplicate" branch (see the
 * header: the live probe found no such response, so there is nothing real for one to match).
 */
export function classifyPublishResult({ parsed }) {
  if (parsed?.status === "SUCCESS") {
    return {
      ok: true,
      message: `published ${parsed.qualifiedName} — deployment ${parsed.deploymentId} (${parsed.mcpUrl}).`,
    };
  }
  return {
    ok: false,
    message: parsed
      ? `smithery mcp publish returned status "${parsed.status}", expected "SUCCESS".`
      : "smithery mcp publish produced no parseable JSON status line.",
  };
}

/**
 * Orchestrates the publish. `runner` is injected (defaults to `defaultRunner`) so every branch is
 * testable without a subprocess, network access, or a real key.
 */
export function publishToSmithery({
  bundle,
  version,
  dryRun = false,
  runner = defaultRunner,
  name = SMITHERY_NAME,
}) {
  if (isPrerelease(version)) {
    console.log(
      `publish-smithery: ${version} is a prerelease (contains "-") — Smithery publish is ` +
        "reserved for stable releases only. Skipping; nothing read or written.",
    );
    return { action: "skipped-prerelease" };
  }

  if (dryRun) {
    console.log(
      `publish-smithery: [dry-run] would run: smithery mcp publish ${bundle} -n ${name} (release ${version})`,
    );
    return { action: "dry-run" };
  }

  if (!process.env.SMITHERY_API_KEY) {
    throw new Error(
      "SMITHERY_API_KEY is empty — set the repo secret before this job can publish (this repo " +
        "owns the Smithery listing; a silent skip would hide a broken release).",
    );
  }

  let stdout = "";
  let stderr = "";
  let failure = null;
  try {
    stdout = runner("smithery", ["mcp", "publish", bundle, "-n", name]);
  } catch (err) {
    failure = err;
    stdout = err.stdout ?? "";
    stderr = err.stderr ?? "";
  }

  const combined = `${stdout}${stderr}`;
  const parsed = parsePublishOutput(combined);
  const result = classifyPublishResult({ parsed });

  if (!result.ok) {
    const exitNote = failure ? ` (smithery exited ${failure.status ?? "non-zero"})` : "";
    throw new Error(`publish-smithery: ${result.message}${exitNote}`);
  }
  console.log(`publish-smithery: ${result.message} (release ${version})`);
  return { action: "published", ...result };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  publishToSmithery(args);
}

// Importing this module (as its test file does) must have no side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(`publish-smithery: FAIL — ${err.message}`);
    process.exit(1);
  }
}
