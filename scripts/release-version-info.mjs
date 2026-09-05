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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_PACKAGE_JSON = "packages/server/package.json";

/** A version is a prerelease iff it carries semver's `-` prerelease separator. */
export function isPrerelease(version) {
  return version.includes("-");
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

function main() {
  const path = process.argv[2] ?? DEFAULT_PACKAGE_JSON;
  console.log(JSON.stringify(versionInfo(readVersion(path))));
}

// Importing this module (as its test file does) must have no side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
