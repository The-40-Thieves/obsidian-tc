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
    "artifacts/binary-*/obsidian-tc-!(*.map)",
    "artifacts/binary-*/obsidian-tc-*.map",
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

// ---------------------------------------------------------------------------------------------
// Whole-workflow properties: permissions, the signing barrier, and draft -> validate -> publish.
// ---------------------------------------------------------------------------------------------

// Job keys sit under the top-level `jobs:` mapping (the `on:` triggers above it are also
// two-space keys, so only look below it).
const ALL_JOBS = [
  ...WORKFLOW.slice(WORKFLOW.indexOf("\njobs:\n")).matchAll(/^ {2}([a-z][a-z0-9-]*):\n/gm),
].map((m) => m[1]);
const stripComments = (s) => s.replace(/^\s*#.*$/gm, "");

// `needs: x` or `needs: [a, b]` on the job's own 4-space key; [] when absent.
function needsOf(name) {
  const m = jobBlock(name).match(/^ {4}needs: (?:\[(.+)\]|(\S+))$/m);
  if (!m) return [];
  return (m[1] ?? m[2]).split(/,\s*/).map((s) => s.trim());
}

function closure(name, seen = new Set()) {
  for (const dep of needsOf(name)) {
    if (!seen.has(dep)) {
      seen.add(dep);
      closure(dep, seen);
    }
  }
  return seen;
}

// A `permissions:` mapping at a given indent, as { key: value }; null when there is none.
function permissionsAt(text, indent) {
  const pad = " ".repeat(indent);
  const m = text.match(new RegExp(`^${pad}permissions:\\n((?:${pad}  .+\\n)+)`, "m"));
  if (!m) return null;
  return Object.fromEntries(
    m[1]
      .trim()
      .split("\n")
      .map((l) =>
        l
          .replace(/\s+#.*$/, "")
          .trim()
          .split(/:\s*/),
      ),
  );
}

// The workflow-level block is the one at column 0.
const workflowPermissions = (text) => permissionsAt(text, 0);

// Effective permissions: a job-level block REPLACES the workflow block (it is not merged).
function effectivePermissions(name) {
  return permissionsAt(jobBlock(name), 4) ?? workflowPermissions(WORKFLOW);
}

// What each job needs, derived from its steps (see the comment beside each row).
const EXPECTED_PERMISSIONS = {
  "verify-tag": { contents: "read" }, // checkout + git verify-tag
  "build-native": { contents: "read" }, // checkout, build, upload-artifact
  "publish-npm": { contents: "read", "id-token": "write" }, // `npm publish --provenance` mints an OIDC token
  "publish-registry": { contents: "read", "id-token": "write" }, // mcp-publisher login github-oidc
  "publish-reranker-local": { contents: "read", "id-token": "write" }, // npm publish --provenance
  "publish-embedder-local": { contents: "read", "id-token": "write" }, // npm publish --provenance
  "build-binaries": { contents: "read" },
  "build-plugin": { contents: "read", "id-token": "write", attestations: "write" }, // attest-build-provenance
  "build-docker": { contents: "read", packages: "write", "id-token": "write" }, // GHCR push + cosign sign of the image
  "build-mcpb": { contents: "read" },
  "sign-artifacts": { contents: "read", "id-token": "write" }, // cosign sign-blob (keyless)
  "draft-release": { contents: "write" }, // create/upload/publish the release
  "mirror-plugin-release": { contents: "write" }, // creates the un-prefixed tag + release
  "publish-smithery": { contents: "read" }, // API key only
};

// Markers of a step that needs an OIDC token.
const OIDC_MARKERS = [
  /npm publish --provenance/,
  /actions\/attest-build-provenance/,
  /cosign sign(-blob)? /,
  /login github-oidc/,
];

test("workflow-level permissions are read-only; write scopes are granted per job", () => {
  assert.deepEqual(workflowPermissions(WORKFLOW), { contents: "read" });
});

test("the permission check rejects the old workflow-level block (RED fixture)", () => {
  const old = [
    "name: x",
    "permissions:",
    "  contents: write",
    "  packages: write",
    "  id-token: write",
    "  attestations: write",
    "",
    "jobs:",
    "",
  ].join("\n");
  assert.notDeepEqual(workflowPermissions(old), { contents: "read" });
  assert.equal(workflowPermissions(old)["id-token"], "write");
});

test("every job is in the permission table and its effective permissions match it exactly", () => {
  assert.deepEqual([...ALL_JOBS].sort(), Object.keys(EXPECTED_PERMISSIONS).sort());
  for (const job of ALL_JOBS) {
    assert.deepEqual(effectivePermissions(job), EXPECTED_PERMISSIONS[job], `permissions of ${job}`);
  }
});

test("id-token: write is held by exactly the jobs with an OIDC step, workflow-wide", () => {
  for (const job of ALL_JOBS) {
    const holds = effectivePermissions(job)["id-token"] === "write";
    const uses = OIDC_MARKERS.some((re) => re.test(stripComments(jobBlock(job))));
    assert.equal(
      holds,
      uses,
      `${job}: id-token ${holds ? "granted" : "absent"}, OIDC step ${uses}`,
    );
  }
});

test("every publishing job transitively needs sign-artifacts, so a signing failure ships nothing", () => {
  const PUBLISHES = [
    /npm publish/,
    /napi pre-publish/,
    /docker\/build-push-action/,
    /softprops\/action-gh-release/,
    /mirror-plugin-release\.mjs/,
    /publish-smithery\.mjs/,
    /login github-oidc/,
  ];
  const publishers = ALL_JOBS.filter((job) =>
    PUBLISHES.some((re) => re.test(stripComments(jobBlock(job)))),
  );
  for (const expected of [
    "publish-npm",
    "publish-registry",
    "publish-reranker-local",
    "publish-embedder-local",
    "build-docker",
    "draft-release",
    "mirror-plugin-release",
    "publish-smithery",
  ]) {
    assert.ok(publishers.includes(expected), `${expected} should be detected as a publisher`);
  }
  for (const job of publishers) {
    assert.ok(
      closure(job).has("sign-artifacts"),
      `${job} publishes but does not need sign-artifacts`,
    );
  }
});

test("the signing job depends on no publisher (no cycle, and signing precedes every publication)", () => {
  for (const dep of closure("sign-artifacts")) {
    assert.ok(
      !["publish-npm", "build-docker", "draft-release", "publish-registry"].includes(dep),
      `sign-artifacts must not depend on ${dep}`,
    );
  }
});

test("the GHCR image is signed by digest, keylessly, and verified against the workflow identity", () => {
  const docker = jobBlock("build-docker");
  assert.match(docker, /uses: docker\/build-push-action@[0-9a-f]{40}[^\n]*\n\s+id: push\n/);
  assert.match(docker, /uses: sigstore\/cosign-installer@[0-9a-f]{40} # v\d+\.\d+\.\d+/);
  assert.match(docker, /DIGEST: \$\{\{ steps\.push\.outputs\.digest \}\}/);
  assert.match(docker, /cosign sign --yes "\$\{IMAGE\}@\$\{DIGEST\}"/);
  assert.match(docker, /cosign verify "\$\{IMAGE\}@\$\{DIGEST\}"/);
  assert.match(docker, /--certificate-identity "\$IDENTITY"/);
  // signed only after the push
  assert.ok(docker.indexOf("id: push") < docker.indexOf("cosign sign --yes"));
});

test("the signature manifest lists every bundle sign-artifacts produced and ships with the signatures", () => {
  assert.match(sign, /signature-manifest\.tsv/);
  assert.match(sign, /printf '%s\\t%s\\n' "\$key" "\$\(basename "\$out"\)"/);
  // the manifest is not a release asset: draft-release attaches only signatures/*.sigstore.json
  assert.doesNotMatch(draft, /^ {12}signatures\/signature-manifest/m);
});

test("the sign_family keys match the families check-release-assets.sh pins, with matching counts", () => {
  const script = readFileSync(resolve(import.meta.dirname, "check-release-assets.sh"), "utf8");
  const pinned = Object.fromEntries(
    [...script.matchAll(/^ {2}\[([a-z-]+)\]=(\d+)$/gm)].map((m) => [m[1], Number(m[2])]),
  );
  const keys = [...sign.matchAll(/^ {10}sign_family (\S+) /gm)].map((m) => m[1]);
  assert.deepEqual([...keys].sort(), Object.keys(pinned).sort());
  assert.equal(
    Object.values(pinned).reduce((a, b) => a + b, 0),
    24,
  );
  // native and binary counts are the number of matrix rows in the jobs that build them
  const rows = (job) => (jobBlock(job).match(/^ {10}- host:/gm) ?? []).length;
  assert.equal(rows("build-native"), pinned.native);
  assert.equal(rows("build-binaries"), pinned.binary);
  assert.equal(rows("build-binaries"), pinned["binary-map"]);
});

test("draft-release creates a DRAFT, validates it, and only then publishes it", () => {
  const body = stripComments(draft);
  assert.doesNotMatch(body, /draft: false/);
  const create = body.indexOf("softprops/action-gh-release@");
  const validate = body.indexOf("check-release-assets.sh");
  const publish = body.indexOf("--method PATCH");
  assert.ok(create > 0 && validate > create && publish > validate, "create < validate < publish");
  assert.match(body, /uses: softprops\/action-gh-release@[0-9a-f]{40}[^\n]*\n\s+id: release\n/);
  assert.match(body, /^ {10}draft: true$/m);
  // validation gets the release id (a draft has no tag lookup) and the signature manifest
  assert.match(
    body,
    /check-release-assets\.sh "\$RELEASE_ID" artifacts\/SHASUMS256\.txt signatures\/signature-manifest\.tsv/,
  );
  assert.match(body, /RELEASE_ID: \$\{\{ steps\.release\.outputs\.id \}\}/);
  // the publish step runs on success only (no always()/failure()) and is the final step
  assert.doesNotMatch(body, /always\(\)|failure\(\)|continue-on-error/);
  const lastStep = body.slice(body.lastIndexOf("\n      - "));
  assert.ok(lastStep.includes("--method PATCH"), "the publish step is the last step");
  assert.match(lastStep, /draft=false/);
  assert.match(lastStep, /make_latest/);
});

test("the un-prefixed plugin mirror attaches the bundles as well", () => {
  const mirror = jobBlock("mirror-plugin-release");
  assert.match(mirror, /name: signatures\n\s+path: signatures/);
  assert.match(mirror, /--signatures-dir signatures/);
});

test("release docs pin an exact certificate identity and keep no case-folded or loose regexp", () => {
  const exact =
    "https://github.com/The-40-Thieves/obsidian-tc/.github/workflows/publish.yml@refs/tags/v<x.y.z>";
  for (const file of ["../SECURITY.md", "../docs/RELEASING.md"]) {
    const text = readFileSync(resolve(import.meta.dirname, file), "utf8");
    assert.ok(text.includes(`--certificate-identity ${exact}`), `${file}: exact identity form`);
    assert.doesNotMatch(text, /\(\?i\)/, `${file}: no case folding`);
    assert.doesNotMatch(text, /refs\/tags\/v\.\+/, `${file}: no loose v.+ tag`);
    for (const m of text.matchAll(/--certificate-identity-regexp '([^']+)'/g)) {
      assert.ok(m[1].startsWith("^") && m[1].endsWith("$"), `${file}: regexp anchored`);
      assert.ok(m[1].includes("The-40-Thieves/obsidian-tc"), `${file}: owner/repo in real case`);
      assert.ok(m[1].includes("(0|[1-9][0-9]*)"), `${file}: strict semver numeric parts`);
      assert.doesNotMatch(m[1], /\.\+|\.\*/, `${file}: no wildcard`);
    }
  }
  const sec = readFileSync(resolve(import.meta.dirname, "../SECURITY.md"), "utf8");
  assert.match(sec, /cosign verify ghcr\.io\/the-40-thieves\/obsidian-tc@sha256:/);
});

test("the identity the docs name is the workflow file and ref shape this repo actually has", () => {
  assert.match(WORKFLOW, /^name: publish$/m);
  assert.match(WORKFLOW, /^ {4}tags: \['v\*'\]$/m);
});
