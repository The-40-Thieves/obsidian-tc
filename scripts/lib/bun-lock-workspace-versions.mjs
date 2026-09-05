// Shared bun.lock workspace-version helpers (THE-948).
//
// bun.lock caches each workspace's version in `workspaces["<path>"].version`, refreshed only when
// a non-frozen `bun install` touches it — and a version-only package.json bump does not touch it
// (measured at the 1.26.0 and 1.27.0 cuts: `bun install` reported no changes and left the stale
// version in place, so check-version-coherence.mjs's lockfile assertion — THE-947 — failed on
// every release cut until the entries were edited by hand, done for 1.26.0 as f54806ec).
// release.mjs imports `updateBunLockWorkspaceVersions` to fix this in the same pass as the
// package.json bumps, before `bun install` / `bun run format` / the coherence gate run.
//
// WORKSPACE_PACKAGE_JSON and `parseBunLock` are shared with check-version-coherence.mjs, which
// imports both instead of keeping its own copy — one inventory of "which workspace paths carry a
// lockstep version field", not two that can drift apart.
export const WORKSPACE_PACKAGE_JSON = {
  "packages/native": "packages/native/package.json",
  "packages/plugin": "packages/plugin/package.json",
  "packages/server": "packages/server/package.json",
  "packages/shared": "packages/shared/package.json",
};

// bun.lock is a lenient JSON dialect (bun accepts trailing commas that plain JSON does not); strip
// them before parsing rather than pull in a JSON5 dependency for one field.
export function parseBunLock(lockText) {
  return JSON.parse(lockText.replace(/,(\s*[}\]])/g, "$1"));
}

/**
 * Pure check, injectable so it is testable without a filesystem (mirrors check-mcp-name.mjs's
 * `mcpNameProblems` shape). check-version-coherence.mjs (THE-947) imports this instead of keeping
 * its own copy, so THE-948's tests can assert `updateBunLockWorkspaceVersions`'s output against
 * this SAME assertion rather than a re-implementation of it. `packageVersions` maps each
 * WORKSPACE_PACKAGE_JSON path to its package.json's version string. Returns a list of problem
 * strings; an empty list means the gate passes.
 */
export function bunLockWorkspaceVersionProblems(lockText, packageVersions) {
  const lock = parseBunLock(lockText);
  const problems = [];
  for (const wsPath of Object.keys(WORKSPACE_PACKAGE_JSON)) {
    const ws = lock.workspaces?.[wsPath];
    if (!ws || ws.version === undefined) {
      problems.push(`bun.lock has no "${wsPath}" workspace with a version field`);
      continue;
    }
    const pkgVersion = packageVersions[wsPath];
    if (ws.version !== pkgVersion) {
      problems.push(
        `bun.lock workspaces["${wsPath}"].version is "${ws.version}", but ` +
          `${WORKSPACE_PACKAGE_JSON[wsPath]}'s version is "${pkgVersion}" — run \`bun install\` ` +
          `to refresh the lockfile.`,
      );
    }
  }
  return problems;
}

function findMatchingBrace(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error("bun.lock: unbalanced braces while scanning a workspace block");
}

/**
 * Pure text rewrite: bumps `workspaces["<path>"].version` to `version` for every path in
 * WORKSPACE_PACKAGE_JSON that has a version field present in `lockText`, leaving every other byte
 * identical. A workspace missing a version field is left alone (nothing invented); a workspace
 * already at `version` is a no-op (idempotent); a path not present in the lockfile at all is
 * skipped rather than erroring, so this stays usable against partial fixtures in tests.
 *
 * String surgery, not parse-mutate-reserialize: bun.lock's formatting (2-space indent, trailing
 * commas, key order) is not what JSON.stringify produces, so round-tripping through JSON would
 * rewrite the whole file instead of the four version fields. Each workspace's block is found by
 * brace-balancing from its `"<path>": {` key to the matching close, then the block's own
 * `"version": "..."` field (there is exactly one per workspace) is replaced in place.
 */
export function updateBunLockWorkspaceVersions(lockText, version) {
  let result = lockText;
  for (const path of Object.keys(WORKSPACE_PACKAGE_JSON)) {
    const keyNeedle = `"${path}": {`;
    const keyIdx = result.indexOf(keyNeedle);
    if (keyIdx === -1) continue; // this workspace member is not in the lockfile at all
    const blockStart = keyIdx + keyNeedle.length - 1; // index of the opening "{"
    const blockEnd = findMatchingBrace(result, blockStart);
    const block = result.slice(blockStart, blockEnd + 1);
    const versionField = block.match(/"version":\s*"([^"]*)"/);
    if (!versionField) continue; // no version field on this workspace — leave it alone
    if (versionField[1] === version) continue; // already at `version`
    const newField = versionField[0].replace(versionField[1], version);
    const newBlock =
      block.slice(0, versionField.index) +
      newField +
      block.slice(versionField.index + versionField[0].length);
    result = result.slice(0, blockStart) + newBlock + result.slice(blockEnd + 1);
  }
  return result;
}
