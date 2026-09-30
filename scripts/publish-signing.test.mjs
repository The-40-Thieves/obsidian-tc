// Structural checks on the keyless cosign signing wired into .github/workflows/publish.yml.
//
// Nothing on a PR executes publish.yml (it fires only on a pushed v* tag), so a mistake in the
// signing job would first show up mid-release, after npm's immutable publish. These assertions
// pin the properties a review would otherwise have to re-derive by eye: the installer is pinned to
// a commit, only the signing job may mint an OIDC token via its own job-scoped permissions, the
// release cannot be assembled without the signing job, and every artifact family the release
// ships has a signing step feeding the assets the release attaches.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const WORKFLOW = readFileSync(
  resolve(import.meta.dirname, "../.github/workflows/publish.yml"),
  "utf8",
);

// A job is the text from its two-space-indented `name:` key to the next job key (or EOF).
function jobBlock(name) {
  const m = WORKFLOW.match(
    new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:\\n|(?![\\s\\S]))`, "m"),
  );
  assert.ok(m, `job ${name} not found in publish.yml`);
  return m[1];
}

const sign = jobBlock("sign-artifacts");
const draft = jobBlock("draft-release");

test("cosign-installer is pinned by full commit SHA and the cosign release is pinned to v3.x", () => {
  assert.match(sign, /uses: sigstore\/cosign-installer@[0-9a-f]{40} # v\d+\.\d+\.\d+/);
  assert.match(sign, /cosign-release: 'v3\.\d+\.\d+'/);
});

test("the signing job carries its own job-scoped permissions: id-token write, contents read, nothing else", () => {
  const perms = sign.match(/^ {4}permissions:\n((?: {6}.+\n)+)/m);
  assert.ok(
    perms,
    "sign-artifacts must declare job-level permissions (they REPLACE the workflow block)",
  );
  assert.deepEqual(
    perms[1]
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .sort(),
    ["contents: read", "id-token: write"],
  );
});

test("signing is keyless, uses the bundle form, and none of the deprecated output flags", () => {
  assert.match(sign, /cosign sign-blob --yes --bundle /);
  assert.doesNotMatch(sign, /--output-signature|--output-certificate|--key\b|COSIGN_PRIVATE_KEY/);
});

test("every bundle is verified in-job against this workflow's identity before it ships", () => {
  assert.match(sign, /cosign verify-blob/);
  assert.match(sign, /--certificate-identity "\$IDENTITY"/);
  assert.match(sign, /--certificate-oidc-issuer "\$ISSUER"/);
  assert.match(sign, /ISSUER=https:\/\/token\.actions\.githubusercontent\.com\n/);
  assert.match(sign, /IDENTITY="\$\{GITHUB_SERVER_URL\}\/\$\{GITHUB_WORKFLOW_REF\}"/);
});

test("the signing job runs after every build job and is skipped on the same dry-run guard as the release", () => {
  const needs = sign.match(/^ {4}needs: \[(.+)\]$/m);
  assert.ok(needs, "sign-artifacts needs a needs: list");
  for (const job of [
    "build-native",
    "build-binaries",
    "build-plugin",
    "build-mcpb",
    "verify-tag",
  ]) {
    assert.ok(needs[1].split(/,\s*/).includes(job), `sign-artifacts must need ${job}`);
  }
  assert.match(sign, /if: github\.event_name == 'push' \|\| !inputs\.dry_run/);
});

test("every released artifact family is downloaded and has a signing step with an existence floor", () => {
  for (const pattern of ["native-*", "binary-*", "plugin", "mcpb"]) {
    assert.ok(sign.includes(pattern), `the download pattern must cover ${pattern}`);
  }
  for (const target of [
    "artifacts/native-*/*.node",
    "artifacts/binary-*/obsidian-tc-*",
    "artifacts/plugin/**/obsidian-tc-*.zip",
    "artifacts/plugin/**/main.js",
    "artifacts/plugin/**/manifest.json",
    "artifacts/plugin/**/styles.css",
    "artifacts/mcpb/**/*.mcpb",
  ]) {
    assert.ok(
      sign.includes(`sign_family `) && sign.includes(target),
      `no signing step for ${target}`,
    );
  }
  assert.match(
    sign,
    /\[ "\$n" -gt 0 \]/,
    "a family that matched no files must fail, not pass vacuously",
  );
});

test("the signatures are uploaded as their own artifact", () => {
  assert.match(sign, /name: signatures\n\s+path: signatures\/\n\s+if-no-files-found: error/);
});

test("draft-release cannot run without the signing job and attaches the bundles", () => {
  const needs = draft.match(/^ {4}needs: \[(.+)\]$/m);
  assert.ok(needs, "draft-release needs a needs: list");
  assert.ok(needs[1].split(/,\s*/).includes("sign-artifacts"));
  assert.match(draft, /name: signatures\n\s+path: signatures/);
  assert.match(draft, /^ {12}signatures\/\*\.sigstore\.json$/m);
});

test("the bundle glob cannot double-match a pattern already in files: (queues an asset twice)", () => {
  // The bundles are downloaded OUTSIDE artifacts/, so `artifacts/**/obsidian-tc-*` (which would
  // match a bundle named obsidian-tc-<x>.sigstore.json) never sees them.
  assert.doesNotMatch(draft, /path: artifacts\/signatures/);
  assert.match(draft, /path: signatures/);
});
