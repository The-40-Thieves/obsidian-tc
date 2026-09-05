// Tests for scripts/lib/bun-lock-workspace-versions.mjs (THE-948).
//
// `updateBunLockWorkspaceVersions` is pure and takes lock text directly, so most of these run
// against a small in-memory fixture shaped like a real bun.lock rather than the filesystem —
// mirroring check-mcp-name.test.mjs's injected-dependency shape. The last two tests cross-check
// against the real repo files, because a fixture alone cannot prove the rewriter agrees with what
// check-version-coherence.mjs (THE-947) actually asserts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  bunLockWorkspaceVersionProblems,
  updateBunLockWorkspaceVersions,
  WORKSPACE_PACKAGE_JSON,
} from "./lib/bun-lock-workspace-versions.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Shaped like the real bun.lock: a root "" workspace with no version field, plus the four
// lockstep members, each with a "version" field immediately after "name" and other fields that
// must survive untouched.
const FIXTURE = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "obsidian-tc-monorepo",
      "devDependencies": {
        "typescript": "^7.0.2",
      },
    },
    "packages/native": {
      "name": "@the-40-thieves/obsidian-tc-native",
      "version": "1.26.0",
      "devDependencies": {
        "@napi-rs/cli": "^3.7.2",
      },
    },
    "packages/plugin": {
      "name": "@the-40-thieves/obsidian-tc-plugin",
      "version": "1.26.0",
      "devDependencies": {
        "obsidian": "^1.13.1",
      },
    },
    "packages/server": {
      "name": "obsidian-tc",
      "version": "1.26.0",
      "dependencies": {
        "hono": "^4.12.34",
      },
    },
    "packages/shared": {
      "name": "@the-40-thieves/obsidian-tc-shared",
      "version": "1.26.0",
      "dependencies": {
        "zod": "^4.0.0",
      },
    },
  },
  "trustedDependencies": [
    "better-sqlite3",
  ],
}
`;

function diffLines(a, b) {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  assert.equal(aLines.length, bLines.length, "rewrite must not add or remove lines");
  const changed = [];
  for (let i = 0; i < aLines.length; i++) {
    if (aLines[i] !== bLines[i]) changed.push({ line: i + 1, before: aLines[i], after: bLines[i] });
  }
  return changed;
}

test("four workspace members at 1.26.0 -> all four at 1.27.0, exactly four lines changed", () => {
  const after = updateBunLockWorkspaceVersions(FIXTURE, "1.27.0");
  const changed = diffLines(FIXTURE, after);
  assert.equal(changed.length, 4);
  for (const c of changed) {
    assert.match(c.before, /"version": "1\.26\.0",/);
    assert.match(c.after, /"version": "1\.27\.0",/);
  }
});

test("a workspace without a version field is left alone", () => {
  const after = updateBunLockWorkspaceVersions(FIXTURE, "1.27.0");
  // The root "" workspace never had a version field, and package.json path
  // WORKSPACE_PACKAGE_JSON does not even list it as a lockstep member — its block must be
  // byte-identical before and after.
  const rootBlockBefore = FIXTURE.slice(
    FIXTURE.indexOf('"": {'),
    FIXTURE.indexOf('"packages/native"'),
  );
  const rootBlockAfter = after.slice(after.indexOf('"": {'), after.indexOf('"packages/native"'));
  assert.equal(rootBlockAfter, rootBlockBefore);
});

test("idempotent: running twice equals running once", () => {
  const once = updateBunLockWorkspaceVersions(FIXTURE, "1.27.0");
  const twice = updateBunLockWorkspaceVersions(once, "1.27.0");
  assert.equal(twice, once);
});

test("the real repo bun.lock passes through unchanged when given its current version", () => {
  const lockText = readFileSync(resolve(ROOT, "bun.lock"), "utf8");
  const currentVersion = JSON.parse(
    readFileSync(resolve(ROOT, "packages/server/package.json"), "utf8"),
  ).version;
  const after = updateBunLockWorkspaceVersions(lockText, currentVersion);
  assert.equal(after, lockText);
});

test("live check: the coherence checker's own lockfile assertion accepts the rewritten text", () => {
  const rewritten = updateBunLockWorkspaceVersions(FIXTURE, "1.27.0");
  const packageVersions = Object.fromEntries(
    Object.keys(WORKSPACE_PACKAGE_JSON).map((wsPath) => [wsPath, "1.27.0"]),
  );
  assert.deepEqual(bunLockWorkspaceVersionProblems(rewritten, packageVersions), []);
  // Sanity: the SAME assertion still fails against the un-rewritten fixture, so the "accepts"
  // result above is not a check that accepts everything.
  assert.notDeepEqual(bunLockWorkspaceVersionProblems(FIXTURE, packageVersions), []);
});
