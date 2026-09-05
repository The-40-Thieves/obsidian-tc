#!/usr/bin/env node
// mirror-plugin-release (THE-955) — Obsidian's community-directory validator (and the
// community.obsidian.md self-service submission form) reads the release whose TAG EQUALS
// manifest.json's version, not the repo's own `v<version>` convention. Every obsidian-tc release
// is tagged `v<version>` (publish.yml's `on.push.tags: ['v*']`), so the plugin's manifest version
// never had a matching release — the first real submission (2026-09-05) was rejected with "No
// release matches your manifest version... it should be '1.0.0' not 'v1.0.0'." Fixed by hand for
// 1.27.0 (a signed tag `1.27.0` + a non-latest release carrying the three loose plugin assets);
// this script makes that mirror automatic on every tag, idempotent on re-run.
//
// The un-prefixed `<version>` tag cannot re-trigger publish.yml — its trigger is `tags: ['v*']`
// only, and `<version>` never starts with `v` (verified: no workflow in this repo listens on
// `release` events either, so `gh release create` below fires nothing further).
//
// `--latest=false` is load-bearing: without it, GitHub would flip "Latest" from `v<version>`
// (the signed, canonical release) onto this un-prefixed mirror the moment it's created. This
// script asserts that stayed put, AFTER creating the release, and fails loudly if it didn't.
//
// The un-prefixed tag is unsigned by construction — CI holds no maintainer signing key (see
// docs/RELEASE-SIGNING.md), so unlike an annotated `v*` tag it cannot carry a `git verify-tag`
// signature. Said again in the release notes below and in publish.yml's job comment.
//
// External commands (`gh`) go through an injectable `runner` so tests can fake them with no
// subprocess and no network — mirrors check-mcp-name.mjs's pure/injectable shape, extended to
// side-effecting calls the way this task's brief asked for. `gh` resolves the target repo from
// the `{owner}/{repo}` placeholders itself (current git remote), so no owner/repo is hardcoded
// here — this also lets `--dry-run` be run safely against the real repo from any checkout of it.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_MANIFEST_ID = "tc-bridge";
const REQUIRED_ASSET_NAMES = ["main.js", "manifest.json", "styles.css"];

/** execFileSync wrapper — shell-free (argv array, no interpolation) and swappable in tests. */
export function defaultRunner(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8" });
}

export function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--version") args.version = argv[++i];
    else if (a === "--assets-dir") args.assetsDir = argv[++i];
    else if (a === "--sha") args.sha = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else throw new Error(`mirror-plugin-release: unrecognized argument: ${a}`);
  }
  for (const [key, flag] of Object.entries({
    version: "--version",
    assetsDir: "--assets-dir",
    sha: "--sha",
  })) {
    if (!args[key]) throw new Error(`mirror-plugin-release: ${flag} is required`);
  }
  return args;
}

/**
 * Pure check against an already-parsed manifest.json, injectable so it's testable with no
 * filesystem. Returns a list of problem strings; an empty list means the gate passes.
 */
export function manifestProblems(manifest, version) {
  const problems = [];
  if (manifest?.id !== REQUIRED_MANIFEST_ID) {
    problems.push(`manifest.json's id is "${manifest?.id}", expected "${REQUIRED_MANIFEST_ID}".`);
  }
  if (manifest?.version !== version) {
    problems.push(`manifest.json's version is "${manifest?.version}", expected "${version}".`);
  }
  return problems;
}

/** Pure diff, injectable so it's testable with no filesystem. */
export function missingAssetNames(existingNames, required = REQUIRED_ASSET_NAMES) {
  const existing = new Set(existingNames);
  return required.filter((name) => !existing.has(name));
}

/** Returns the release's current asset names, or `null` if release `version` does not exist. */
export function readExistingRelease(version, runner) {
  try {
    const out = runner("gh", [
      "release",
      "view",
      version,
      "--json",
      "assets",
      "--jq",
      ".assets[].name",
    ]);
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (err) {
    const text = `${err.stderr ?? ""}${err.stdout ?? ""}${err.message ?? ""}`;
    if (/release not found|not found/i.test(text)) return null;
    throw err;
  }
}

/** Returns whether the lightweight ref `refs/tags/<version>` already exists on the remote. */
export function tagExists(version, runner) {
  try {
    runner("gh", ["api", `repos/{owner}/{repo}/git/ref/tags/${version}`]);
    return true;
  } catch (err) {
    const text = `${err.stderr ?? ""}${err.stdout ?? ""}${err.message ?? ""}`;
    if (/404|not found/i.test(text)) return false;
    throw err;
  }
}

/** Returns the tag name of the repo's current "Latest" release. */
export function latestReleaseTag(runner) {
  return runner("gh", ["api", "repos/{owner}/{repo}/releases/latest", "--jq", ".tag_name"]).trim();
}

function releaseNotes(version) {
  return [
    `TC Bridge (Obsidian companion plugin) build for manifest version ${version}, mirrored ` +
      `automatically from the signed release v${version}.`,
    "",
    `This tag ("${version}", no "v" prefix) exists only to satisfy Obsidian's community-directory ` +
      `rule that a plugin release's tag equal manifest.json's version — every other obsidian-tc ` +
      `release stays tagged v${version}. It carries the identical three plugin assets ` +
      "(main.js, manifest.json, styles.css) already attached to that release.",
    "",
    `Unlike v${version}, this tag is UNSIGNED: CI holds no maintainer signing key (see ` +
      "docs/RELEASE-SIGNING.md), so it cannot carry a verify-tag signature the way an annotated " +
      `v* tag can once a key is configured. Treat v${version} as the authoritative, signed release.`,
  ].join("\n");
}

/**
 * Orchestrates the mirror. `runner` is injected (defaults to `defaultRunner`) so every branch is
 * testable without a subprocess or network access.
 */
export function mirrorPluginRelease({
  version,
  assetsDir,
  sha,
  dryRun = false,
  runner = defaultRunner,
}) {
  const manifestPath = join(assetsDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const problems = manifestProblems(manifest, version);
  if (problems.length > 0) {
    throw new Error(
      `manifest.json mismatch, refusing before any gh call:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }

  const assetPaths = REQUIRED_ASSET_NAMES.map((name) => join(assetsDir, name));
  for (const p of assetPaths) {
    if (!existsSync(p)) throw new Error(`required asset missing on disk: ${p}`);
  }

  const existingNames = readExistingRelease(version, runner);

  if (existingNames !== null) {
    const missing = missingAssetNames(existingNames);
    if (missing.length === 0) {
      console.log(
        `mirror-plugin-release: release ${version} already exists and carries all 3 assets — already mirrored.`,
      );
      return { action: "already-mirrored" };
    }
    console.log(
      `mirror-plugin-release: release ${version} exists but is missing: ${missing.join(", ")}.`,
    );
    if (dryRun) {
      console.log(`mirror-plugin-release: [dry-run] would upload: ${missing.join(", ")}`);
      return { action: "dry-run-partial", missing };
    }
    const missingPaths = missing.map((name) => join(assetsDir, name));
    runner("gh", ["release", "upload", version, ...missingPaths]);
    console.log(`mirror-plugin-release: uploaded missing asset(s): ${missing.join(", ")}.`);
    return { action: "filled-missing", missing };
  }

  const hasTag = tagExists(version, runner);
  if (dryRun) {
    console.log(
      `mirror-plugin-release: [dry-run] release ${version} does not exist. Would ` +
        `${hasTag ? "reuse the existing" : "create a"} tag ${version} at ${sha}, then create ` +
        `release ${version} (--latest=false) with assets: ${REQUIRED_ASSET_NAMES.join(", ")}.`,
    );
    return { action: "dry-run-fresh" };
  }

  if (!hasTag) {
    runner("gh", [
      "api",
      "repos/{owner}/{repo}/git/refs",
      "-f",
      `ref=refs/tags/${version}`,
      "-f",
      `sha=${sha}`,
    ]);
    console.log(`mirror-plugin-release: created tag ${version} at ${sha}.`);
  } else {
    console.log(`mirror-plugin-release: tag ${version} already exists, reusing it.`);
  }

  runner("gh", [
    "release",
    "create",
    version,
    "--latest=false",
    "--verify-tag",
    "--title",
    `TC Bridge ${version} (companion plugin)`,
    "--notes",
    releaseNotes(version),
    ...assetPaths,
  ]);
  console.log(`mirror-plugin-release: created release ${version} with 3 assets.`);

  const latestTag = latestReleaseTag(runner);
  const expectedLatest = `v${version}`;
  if (latestTag !== expectedLatest) {
    throw new Error(
      `after creating release ${version}, the repo's Latest release is "${latestTag}", expected ` +
        `"${expectedLatest}" — --latest=false should have kept v${version} as Latest. The mirror ` +
        "release was created; investigate the Latest flag before trusting it.",
    );
  }
  console.log(`mirror-plugin-release: confirmed ${expectedLatest} is still the Latest release.`);
  return { action: "created" };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  mirrorPluginRelease(args);
}

// Importing this module (as its test file does) must have no side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(`mirror-plugin-release: FAIL — ${err.message}`);
    process.exit(1);
  }
}
