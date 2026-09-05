#!/usr/bin/env node
// release-version-info (THE-957) — classifies the release version ONCE, so publish.yml's
// verify-tag job can expose it as job outputs (`version`, `prerelease`) for every downstream
// publish job to read instead of each recomputing its own `if [[ "$version" == *"-"* ]]`.
//
// Before this, five separate steps across publish.yml (publish-npm's dist-tag choice,
// publish-reranker-local's dist-tag choice, build-docker's "is pre-release" step, and the
// mirror-plugin-release / publish-smithery skip guards) each re-derived the same boolean from
// `packages/server/package.json`'s version, independently. draft-release's `action-gh-release`
// step derived NONE of them, so it passed neither `prerelease:` nor `make_latest:` — meaning a
// tag like `v1.28.0-rc.1` would be published as a normal, Latest GitHub release, which
// `/releases/latest`, BRAT and the Obsidian directory all read.
//
// `version` is un-prefixed (plain semver from package.json, never the `v`-prefixed git ref) —
// every other version string in this repo is un-prefixed too (see docs/RELEASING.md). A version
// is a prerelease when it contains a hyphen (semver's own prerelease separator, e.g.
// `1.28.0-rc.1`, `1.28.0-beta`), matching the classification every one of those five call sites
// already used.
//
// Fix round 1 (review INFO finding): the classification above is entirely derived from
// package.json, never from the pushed tag's own name — so a tag `v1.28.0-rc.1` pushed against a
// commit whose package.json still says `1.28.0` (a stale checkout, a forgotten bump, a
// re-tagged commit) would silently classify as a STABLE release: npm `latest`, a `:latest` ghcr
// tag, a Latest GitHub release, the plugin mirror and the Smithery publish all fire from the
// wrong classification. `tagMatchesVersion` below lets verify-tag assert the two agree before
// trusting either.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_PACKAGE_JSON = "packages/server/package.json";

/** A version is a prerelease iff it carries semver's `-` prerelease separator. */
export function isPrerelease(version) {
  return version.includes("-");
}

/** Strip a leading "v" from a git tag ref (e.g. "v1.28.0-rc.1" -> "1.28.0-rc.1"); a ref with no
 *  leading v is returned unchanged. */
export function stripTagPrefix(ref) {
  return ref.startsWith("v") ? ref.slice(1) : ref;
}

/** True when a `v`-prefixed (or bare) git tag ref names the same version as package.json's
 *  version string. */
export function tagMatchesVersion(tagRef, version) {
  return stripTagPrefix(tagRef) === version;
}

/** Pure: given a version string, return the `{ version, prerelease }` info this script prints
 *  and publish.yml's verify-tag job exposes as outputs. Split out from main() so it needs no
 *  filesystem to test. */
export function versionInfo(version) {
  return { version, prerelease: isPrerelease(version) };
}

/** Read `version` out of a package.json at `path` (default packages/server/package.json). */
export function readVersion(path = DEFAULT_PACKAGE_JSON) {
  const pkg = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (!pkg.version) {
    throw new Error(`${path} has no "version" field`);
  }
  return pkg.version;
}

// CLI: `release-version-info.mjs [packageJsonPath] [tagRef]`. `tagRef`, when given, is checked
// against the version BEFORE printing anything -- a mismatch is a hard failure (used by
// verify-tag to refuse a tag that does not name the version it would otherwise classify from).
function main() {
  const path = process.argv[2] ?? DEFAULT_PACKAGE_JSON;
  const tagRef = process.argv[3];
  const version = readVersion(path);
  if (tagRef !== undefined && !tagMatchesVersion(tagRef, version)) {
    console.error(
      `::error title=tag/version mismatch::tag "${tagRef}" does not name the same version as ` +
        `${path} ("${version}") -- refusing to classify or release from a mismatched tag.`,
    );
    process.exit(1);
  }
  console.log(JSON.stringify(versionInfo(version)));
}

// Importing this module (as its test file does) must have no side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
