// Structural checks on the keyless cosign signing wired into .github/workflows/publish.yml.
//
// Nothing on a PR executes publish.yml (it fires only on a pushed v* tag), so a mistake in the
// signing job would first show up mid-release, after npm's immutable publish. These assertions
// pin the properties a review would otherwise have to re-derive by eye: the installer is pinned to
// a commit, only the signing job may mint an OIDC token via its own job-scoped permissions, the
// release cannot be assembled without the signing job, and every artifact family the release
// ships has a signing step feeding the assets the release attaches.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  assert.match(sign, /if: github\.event_name == 'push' \|\| \(github\.ref_type == 'tag' && !inputs\.dry_run\)/);
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
  // the image is signed by digest inside the shared composite action build-docker calls
  /smoke-and-promote-image/,
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

// ---- the GHCR image: smoke the exact release digest on both platforms before the public tags move ----
//
// Neither release route runs on a PR, so these pin the properties by structure: the image is pushed
// under a staging tag only, the shared composite action boots BOTH platforms of that digest and
// re-tags that same digest (never a rebuild), and the signature is over that same digest.

const SMOKE_ACTION = readFileSync(
  resolve(import.meta.dirname, "../.github/actions/smoke-and-promote-image/action.yml"),
  "utf8",
);
const RELEASE_IMAGE = readFileSync(
  resolve(import.meta.dirname, "../.github/workflows/release-image.yml"),
  "utf8",
);
const PUBLIC_TAG = /obsidian-tc:\$\{\{ (needs\.verify-tag\.outputs\.version|inputs\.version) \}\}/;

/** The `tags:` input of the build-push-action step, up to the next `labels:` key. */
function buildTags(text) {
  const m = text.match(/docker\/build-push-action@[\s\S]*?\n {10}tags:([\s\S]*?)\n {10}labels:/);
  assert.ok(m, "no build-push-action tags: block found");
  return m[1];
}

for (const [name, text] of [
  ["publish.yml build-docker", jobBlock("build-docker")],
  ["release-image.yml", RELEASE_IMAGE],
]) {
  test(`${name}: the image is pushed under a staging tag only, never a public one`, () => {
    const tags = buildTags(text);
    assert.match(
      tags,
      /obsidian-tc:smoke-\$\{\{ (needs\.verify-tag\.outputs\.version|inputs\.version) \}\}/,
    );
    assert.doesNotMatch(tags, PUBLIC_TAG);
    assert.doesNotMatch(tags, /:latest/);
  });

  test(`${name}: the public tags are given by the smoke-and-promote action, from the pushed digest, after the push`, () => {
    assert.match(text, /uses: docker\/build-push-action@[0-9a-f]{40}[^\n]*\n\s+id: push\n/);
    const step = text.match(
      /uses: \.\/(?:trusted\/)?\.github\/actions\/smoke-and-promote-image\n([\s\S]*?)(?=\n {6}- |\n {2}[a-z]|(?![\s\S]))/,
    );
    assert.ok(step, "smoke-and-promote-image step not found");
    assert.match(step[1], /digest: \$\{\{ steps\.push\.outputs\.digest \}\}/);
    assert.match(step[1], PUBLIC_TAG);
    assert.ok(text.indexOf("id: push") < text.indexOf("smoke-and-promote-image"));
    // QEMU is what lets an amd64 runner boot the arm64 image
    assert.match(text, /uses: docker\/setup-qemu-action@[0-9a-f]{40}/);
  });
}

// The signature is written INSIDE the shared action, between the boot smoke and the promotion, so no
// public tag can point at an unsigned digest. Each route only installs cosign and calls the action.
test("the shared action signs the smoked digest keylessly against the workflow identity, never with a key", () => {
  const run = stripComments(SMOKE_ACTION);
  assert.match(run, /IDENTITY="\$\{GITHUB_SERVER_URL\}\/\$\{GITHUB_WORKFLOW_REF\}"/);
  assert.match(run, /cosign sign --yes "\$\{IMAGE\}@\$\{DIGEST\}"/);
  assert.match(
    run,
    /cosign verify "\$\{IMAGE\}@\$\{DIGEST\}" \\\n\s+--certificate-identity "\$IDENTITY" \\\n\s+--certificate-oidc-issuer "\$ISSUER"/,
  );
  assert.doesNotMatch(run, /--key\b|COSIGN_PRIVATE_KEY|--output-signature/);
});

for (const [name, text] of [
  ["publish.yml build-docker", jobBlock("build-docker")],
  ["release-image.yml", RELEASE_IMAGE],
]) {
  test(`${name}: the image is signed and verified by digest before its public tags are promoted`, () => {
    const route = stripComments(text);
    assert.doesNotMatch(route, /cosign sign /, "signing lives in the shared action, not after it");
    assert.ok(
      route.indexOf("cosign-installer") >= 0 &&
        route.indexOf("cosign-installer") < route.indexOf("smoke-and-promote-image"),
      "cosign is installed before the action runs",
    );
    const run = stripComments(SMOKE_ACTION);
    const smoke = run.indexOf("docker-boot-smoke.mjs");
    const sign = run.indexOf('cosign sign --yes "${IMAGE}@${DIGEST}"');
    const verify = run.indexOf('cosign verify "${IMAGE}@${DIGEST}"');
    const promote = run.indexOf("docker buildx imagetools create");
    assert.ok(
      smoke >= 0 && smoke < sign && sign < verify && verify < promote,
      `order: smoke=${smoke} sign=${sign} verify=${verify} promote=${promote}`,
    );
  });
}

test("the smoke-and-promote action boots both platforms of the digest, then re-tags that digest and checks it", () => {
  const run = stripComments(SMOKE_ACTION);
  assert.match(run, /for platform in linux\/amd64 linux\/arm64/);
  assert.match(run, /docker pull --platform "\$platform" "\$ref"/);
  assert.match(run, /ref="\$\{IMAGE\}@\$\{DIGEST\}"/);
  assert.match(run, /node scripts\/docker-boot-smoke\.mjs "\$ref" --platform "\$platform"/);
  // the architecture of what was pulled is checked, so a wrong-platform image cannot pass as the other
  assert.match(run, /docker image inspect --format '\{\{\.Architecture\}\}'/);
  // promotion is a re-tag of the digest (no rebuild), and every promoted tag is read back
  assert.match(run, /docker buildx imagetools create "\$\{args\[@\]\}" "\$\{IMAGE\}@\$\{DIGEST\}"/);
  assert.match(run, /imagetools inspect "\$t" --format '\{\{\.Manifest\.Digest\}\}'/);
  assert.doesNotMatch(run, /build-push-action|docker build\b|buildx build/);
  // the smoke strictly precedes the promotion
  assert.ok(run.indexOf("docker-boot-smoke.mjs") < run.indexOf("imagetools create"));
});

test("release-image.yml builds from the release tag, not the dispatch ref, and checks the version", () => {
  assert.match(
    RELEASE_IMAGE,
    /uses: actions\/checkout@[0-9a-f]{40}[^\n]*\n\s+with:\n\s+ref: refs\/tags\/v\$\{\{ inputs\.version \}\}/,
  );
  assert.match(RELEASE_IMAGE, /tag v\$\{VERSION\} holds package version \$\{have\}/);
  // the revision label is the tag commit that was built, not the dispatching ref's github.sha
  assert.match(
    RELEASE_IMAGE,
    /org\.opencontainers\.image\.revision=\$\{\{ steps\.source\.outputs\.revision \}\}/,
  );
  assert.doesNotMatch(RELEASE_IMAGE, /github\.sha/);
  // the input is validated before it becomes a ref or a package spec
  assert.ok(
    RELEASE_IMAGE.indexOf("validate the version input") <
      RELEASE_IMAGE.indexOf("actions/checkout@"),
  );
});

test("release-image.yml verifies each npm-delivered .node against the release's Sigstore bundle before staging it", () => {
  const run = stripComments(RELEASE_IMAGE);
  assert.match(run, /gh release download "v\$\{VERSION\}" --pattern "\$\{file\}\.sigstore\.json"/);
  assert.match(run, /cosign verify-blob --bundle "\$work\/\$\{file\}\.sigstore\.json"/);
  assert.match(
    run,
    /IDENTITY="\$\{GITHUB_SERVER_URL\}\/\$\{GITHUB_REPOSITORY\}\/\.github\/workflows\/publish\.yml@refs\/tags\/v\$\{VERSION\}"/,
  );
  assert.match(run, /--certificate-identity "\$IDENTITY"/);
  assert.match(run, /--certificate-oidc-issuer "\$ISSUER"/);
  assert.match(run, /uses: sigstore\/cosign-installer@[0-9a-f]{40} # v\d+\.\d+\.\d+/);
  // verified in a scratch directory, and only moved into the build context afterwards
  assert.ok(run.indexOf("cosign verify-blob") < run.indexOf('mv "$work/'));
  assert.doesNotMatch(run, /tar [^\n]*-C packages\/native/);
  // and the build comes after the whole fetch+verify step
  assert.ok(run.indexOf("cosign verify-blob") < run.indexOf("docker/build-push-action"));
});

// ---- F1: a real publish requires a signed release tag ----

// Runs verify-tag's signature step shell with the runner's three expressions substituted.
function runVerifyTag({ refType, eventName, dryRun }) {
  const m = jobBlock("verify-tag").match(
    /- name: verify the release tag is signed\n[\s\S]*?\n {8}run: \|\n((?: {10}.*\n|\n)+)/,
  );
  assert.ok(m, "verify-tag has no 'verify the release tag is signed' run block");
  const script = m[1]
    .replace(/^ {10}/gm, "")
    .replaceAll("${{ github.ref_type }}", refType)
    .replaceAll("${{ github.event_name }}", eventName)
    .replaceAll("${{ inputs.dry_run }}", dryRun);
  return spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, TAG: "v0.0.0-test", REQUIRE_SIGNED_TAG: "true" },
  });
}

test("verify-tag refuses a real publish from a branch and keeps a branch dry run passing", () => {
  const real = runVerifyTag({ refType: "branch", eventName: "workflow_dispatch", dryRun: "false" });
  assert.notEqual(real.status, 0, real.stdout + real.stderr);
  assert.match(real.stdout, /A real publish requires a signed release tag; dispatch from the tag\./);
  const dry = runVerifyTag({ refType: "branch", eventName: "workflow_dispatch", dryRun: "true" });
  assert.equal(dry.status, 0, dry.stdout + dry.stderr);
});

test("every dry-run-guarded job also requires a tag ref for a real publish", () => {
  const guarded = ALL_JOBS.filter((job) => /^ {4}if: .*!inputs\.dry_run\)?$/m.test(jobBlock(job)));
  assert.deepEqual(guarded.sort(), [
    "build-binaries",
    "build-docker",
    "build-mcpb",
    "build-plugin",
    "draft-release",
    "publish-embedder-local",
    "publish-npm",
    "publish-reranker-local",
    "sign-artifacts",
  ]);
  for (const job of guarded) {
    assert.match(
      jobBlock(job),
      /^ {4}if: github\.event_name == 'push' \|\| \(github\.ref_type == 'tag' && !inputs\.dry_run\)$/m,
      `${job}: non-dry-run guard must require a tag ref`,
    );
  }
});

test("publish.yml header no longer says a dispatch publishes nothing", () => {
  const header = WORKFLOW.slice(0, WORKFLOW.indexOf("\npermissions:"));
  assert.doesNotMatch(header, /This dispatch builds the same 8-target matrix and publishes nothing/);
  assert.match(header, /dry_run=false[^\n]*signed release tag/);
});

test("release-image.yml: the image job holds id-token write at job level, for the keyless signature", () => {
  const image = RELEASE_IMAGE.slice(RELEASE_IMAGE.indexOf("\n  image:\n"));
  assert.deepEqual(permissionsAt(image, 4), {
    contents: "read",
    packages: "write",
    "id-token": "write",
  });
});

test("release-image.yml verifies the release tag signature before anything is built or pushed", () => {
  const run = stripComments(RELEASE_IMAGE);
  const verify = run.indexOf('verify-tag "refs/tags/v${VERSION}"');
  assert.ok(verify > 0, "no signed-tag check in release-image.yml");
  assert.match(RELEASE_IMAGE, /ref: refs\/tags\/v\$\{\{ inputs\.version \}\}\n\s+fetch-depth: 0/);
  assert.match(run, /git -c gpg\.ssh\.allowedSignersFile="\$RUNNER_TEMP\/allowed_signers" verify-tag/);
  assert.ok(verify > run.indexOf("actions/checkout@"), "the tag is fetched before it is verified");
  assert.ok(verify < run.indexOf("npm pack"), "verified before the prebuilds are fetched");
  assert.ok(verify < run.indexOf("docker/build-push-action"), "verified before the image is pushed");
});

// ---- trust root: a tag is verified against main's allowed_signers, never against its own copy ----
//
// A tag carries its own .github/allowed_signers, so whoever can push a tag can add their key to that
// file, sign the tag with it and pass verification. The fixture below reproduces exactly that: origin's
// main lists the maintainer (or nothing at all), the candidate tag's tree lists the attacker, and the
// attacker signs the annotated tag. The runner clone sits at the tag, as actions/checkout leaves it.

const TAG = "v9.9.9-test";
const PUBLISH_VERIFY = "verify the release tag is signed";
const RELEASE_VERIFY = "verify the release tag is signed by an allowed signer";

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The whole `- name:` step block, cut at the next sibling step. */
function stepBlock(text, name) {
  const m = text.match(
    new RegExp(`^( *)- name: ${escapeRe(name)}\\n[\\s\\S]*?(?=^\\1- |(?![\\s\\S]))`, "m"),
  );
  assert.ok(m, `step "${name}" not found`);
  return m[0];
}

/** The `run: |` script of a named step, de-indented. */
function stepScript(text, name) {
  const m = stepBlock(text, name).match(/^( +)run: \|\n([\s\S]*)$/m);
  assert.ok(m, `step "${name}" has no run: | block`);
  const pad = m[1].length + 2;
  const lines = [];
  for (const line of m[2].split("\n")) {
    if (line.trim() !== "" && line.search(/\S/) < pad) break;
    lines.push(line.slice(pad));
  }
  return lines.join("\n");
}

function runStep(text, name, { cwd, env, subs = {} }) {
  let script = stepScript(text, name);
  for (const [expr, value] of Object.entries(subs)) script = script.replaceAll(expr, value);
  return spawnSync("bash", ["-c", script], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
}

function git(cwd, args) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function keypair(dir, name) {
  const priv = join(dir, name);
  const r = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", priv], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `ssh-keygen: ${r.stderr}`);
  return { priv, pub: readFileSync(`${priv}.pub`, "utf8").trim() };
}

/** Runs `check` on a fresh release fixture and removes the fixture's directory whatever happens. */
function withRelease(mainLists, check) {
  const root = mkdtempSync(join(tmpdir(), "publish-signing-"));
  try {
    return check(releaseFixture(root, mainLists));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** origin's main lists `mainLists` ("maintainer", "attacker", or "none" for no file). */
function releaseFixture(root, mainLists) {
  const keys = { maintainer: keypair(root, "maintainer"), attacker: keypair(root, "attacker") };
  const seed = join(root, "seed");
  const origin = join(root, "origin.git");
  const clone = join(root, "clone");
  const runnerTemp = join(root, "runner-temp");
  mkdirSync(runnerTemp);
  git(root, ["init", "-q", "-b", "main", seed]);
  mkdirSync(join(seed, ".github"));
  if (mainLists !== "none") {
    writeFileSync(join(seed, ".github/allowed_signers"), `${mainLists} ${keys[mainLists].pub}\n`);
  }
  writeFileSync(join(seed, "README.md"), "fixture\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-q", "-m", "main"]);
  git(root, ["init", "-q", "--bare", "-b", "main", origin]);
  git(seed, ["push", "-q", origin, "main"]);
  // The candidate: its own tree lists the attacker, and the attacker signs the tag.
  git(seed, ["checkout", "-q", "-b", "candidate"]);
  writeFileSync(join(seed, ".github/allowed_signers"), `# candidate\nattacker ${keys.attacker.pub}\n`);
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-q", "-m", "candidate"]);
  git(seed, [
    "-c",
    "gpg.format=ssh",
    "-c",
    `user.signingkey=${keys.attacker.priv}`,
    "tag",
    "-s",
    "-m",
    "release",
    TAG,
  ]);
  git(seed, ["push", "-q", origin, TAG]);
  git(root, ["clone", "-q", origin, clone]);
  git(clone, ["checkout", "-q", "--detach", TAG]);
  return { clone, runnerTemp };
}

function publishVerify(fx) {
  return runStep(WORKFLOW, PUBLISH_VERIFY, {
    cwd: fx.clone,
    env: { TAG, RUNNER_TEMP: fx.runnerTemp, REQUIRE_SIGNED_TAG: "true" },
    subs: {
      "${{ github.ref_type }}": "tag",
      "${{ github.event_name }}": "push",
      "${{ inputs.dry_run }}": "false",
    },
  });
}

function releaseVerify(fx) {
  return runStep(RELEASE_IMAGE, RELEASE_VERIFY, {
    cwd: fx.clone,
    env: { VERSION: TAG.slice(1), RUNNER_TEMP: fx.runnerTemp },
  });
}

function assertSignersFromMain(script) {
  assert.match(script, /git fetch --no-tags origin main/);
  assert.match(
    script,
    /git show origin\/main:\.github\/allowed_signers > "\$RUNNER_TEMP\/allowed_signers"/,
  );
  assert.match(script, /-s "\$RUNNER_TEMP\/allowed_signers"/, "an empty or missing list must fail closed");
  assert.match(script, /gpg\.ssh\.allowedSignersFile="\$RUNNER_TEMP\/allowed_signers"/);
  assert.doesNotMatch(script, /allowedSignersFile=\.github\/allowed_signers|-f \.github\/allowed_signers/);
}

test("publish verify-tag: the signers come from origin/main, never from the tag (structural)", () => {
  assertSignersFromMain(stepScript(WORKFLOW, PUBLISH_VERIFY));
});

test("publish verify-tag: a doctored tag is refused when only its own tree lists the signer", () => {
  const r = withRelease("maintainer", publishVerify);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /carries a valid signature/);
});

test("publish verify-tag: the same tag verifies when origin/main lists its signer (control)", () => {
  const r = withRelease("attacker", publishVerify);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /carries a valid signature/);
});

test("publish verify-tag: fails closed when origin/main has no allowed_signers", () => {
  const r = withRelease("none", publishVerify);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /carries a valid signature/);
});

test("release-image verify step: the signers come from origin/main, never from the tag (structural)", () => {
  assertSignersFromMain(stepScript(RELEASE_IMAGE, RELEASE_VERIFY));
});

test("release-image verify step: a doctored tag is refused when only its own tree lists the signer", () => {
  const r = withRelease("maintainer", releaseVerify);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
});

test("release-image verify step: the same tag verifies when origin/main lists its signer (control)", () => {
  const r = withRelease("attacker", releaseVerify);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("release-image verify step: fails closed when origin/main has no allowed_signers", () => {
  const r = withRelease("none", releaseVerify);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
});

// ---- release-image runs no repo-local code from the tag ----

test("release-image.yml invokes the action from trusted/, never from the tag checkout", () => {
  const run = stripComments(RELEASE_IMAGE);
  assert.match(run, /uses: \.\/trusted\/\.github\/actions\/smoke-and-promote-image\n/);
  assert.doesNotMatch(run, /uses: \.\/\.github\//);
  assert.doesNotMatch(run, /uses: \.\/src\//);
});

test("release-image.yml checks out the calling workflow commit into trusted/ and the release tag into src/", () => {
  assert.match(RELEASE_IMAGE, /ref: \$\{\{ github\.workflow_sha \}\}\n\s+path: trusted\n/);
  assert.match(
    RELEASE_IMAGE,
    /ref: refs\/tags\/v\$\{\{ inputs\.version \}\}\n\s+fetch-depth: 0\n\s+path: src\n/,
  );
});

test("release-image.yml runs every step that reads the tag's tree in src/, and builds the image from src/", () => {
  for (const step of [
    RELEASE_VERIFY,
    "assert the checked-out source is the requested release",
    "fetch the published native prebuilds (linux x64 + arm64, glibc) and verify their signatures",
  ]) {
    assert.match(stepBlock(RELEASE_IMAGE, step), /^ {8}working-directory: src$/m, step);
  }
  assert.match(
    RELEASE_IMAGE,
    /uses: docker\/build-push-action@[^\n]*\n\s+id: push\n\s+with:\n\s+context: src\n\s+file: src\/Dockerfile\n/,
  );
});

test("the smoke-and-promote action runs its smoke script from its own checkout, not the caller's tree", () => {
  const block = stepBlock(SMOKE_ACTION, "boot-smoke linux/amd64 and linux/arm64 of the staged digest");
  assert.match(block, /^ {6}working-directory: \$\{\{ github\.action_path \}\}\/\.\.\/\.\.\/\.\.$/m);
  assert.match(block, /node scripts\/docker-boot-smoke\.mjs "\$ref" --platform "\$platform"/);
});

test("every publish.yml job other than verify-tag transitively needs verify-tag, so no job runs tag code before the signature gate", () => {
  for (const job of ALL_JOBS) {
    if (job === "verify-tag") continue;
    assert.ok(closure(job).has("verify-tag"), `${job} can run before the signature gate`);
  }
});

// ---- docs: one identity pattern, accepting both release workflows and nothing else ----

test("SECURITY.md accepts both release identities and nothing else", () => {
  const sec = readFileSync(resolve(import.meta.dirname, "../SECURITY.md"), "utf8");
  assert.match(sec, /release-image\.yml/, "SECURITY.md names the recovery workflow");
  const patterns = [...sec.matchAll(/--certificate-identity-regexp '([^']+)'/g)].map((m) => m[1]);
  assert.ok(patterns.length > 0, "SECURITY.md has an identity regexp");
  assert.equal(new Set(patterns).size, 1, "every regexp in SECURITY.md is the same pattern");
  const re = new RegExp(patterns[0]);
  const base = "https://github.com/The-40-Thieves/obsidian-tc/.github/workflows/";
  for (const id of [
    "publish.yml@refs/tags/v1.2.3",
    "release-image.yml@refs/tags/v1.2.3",
    "publish.yml@refs/tags/v1.28.0-rc.1",
  ]) {
    assert.match(base + id, re, `accepts ${id}`);
  }
  for (const id of [
    "publish.yml@refs/heads/main",
    "release-image.yml@refs/heads/main",
    "ci-server.yml@refs/tags/v1.2.3",
    "release.yml@refs/tags/v1.2.3",
    "publish.yml@refs/tags/v01.2.3",
    "publish.yml@refs/tags/v1.2",
    "publish.yml@refs/tags/v1.2.3-",
    "publish.yml@refs/tags/v1.2.3 ",
    "publish.yml@refs/tags/v1.2.3/../x",
  ]) {
    assert.doesNotMatch(base + id, re, `rejects ${id}`);
  }
  assert.doesNotMatch(
    "https://github.com/the-40-thieves/obsidian-tc/.github/workflows/publish.yml@refs/tags/v1.2.3",
    re,
    "owner and repo are matched in their real case",
  );
});
