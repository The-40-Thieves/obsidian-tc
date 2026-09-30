// Behavioural tests for scripts/check-release-assets.sh, the gate that decides whether a draft
// release may be published. `gh` is faked with a stub on PATH that serves a fixed asset list, so
// every case runs offline against the real script.
//
// The case that motivated the rewrite: the eight native `.node` bundles are signed but their files
// are NOT release assets, so SHASUMS256.txt never names them and a manifest-only check could not
// notice a release that lost all eight.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const SCRIPT = resolve(import.meta.dirname, "check-release-assets.sh");

const NATIVE = [
  "linux-x64-gnu",
  "linux-x64-musl",
  "linux-arm64-gnu",
  "linux-arm64-musl",
  "darwin-x64",
  "darwin-arm64",
  "win32-x64-msvc",
  "win32-arm64-msvc",
].map((t) => `obsidian-tc-native.${t}.node`);
const BINARIES = [
  "obsidian-tc-bun-linux-x64",
  "obsidian-tc-bun-linux-arm64",
  "obsidian-tc-bun-darwin-x64",
  "obsidian-tc-bun-darwin-arm64",
  "obsidian-tc-bun-windows-x64.exe",
];
const ZIPS = ["obsidian-tc-plugin-1.2.3.zip", "obsidian-tc-legacy-final-notice-1.0.0.zip"];
const LOOSE = ["main.js", "manifest.json", "styles.css"];
const MCPB = ["obsidian-tc.mcpb"];

// manifest line: <family><TAB><bundle basename>
const FAMILIES = [
  ["native", NATIVE],
  ["binary", BINARIES],
  ["plugin-zip", ZIPS],
  ["plugin-main", ["main.js"]],
  ["plugin-manifest", ["manifest.json"]],
  ["plugin-styles", ["styles.css"]],
  ["mcpb", MCPB],
];
const bundle = (n) => `${n}.sigstore.json`;

// A complete release: the checksummed files (everything but the .node prebuilds), SHASUMS256.txt,
// and every bundle.
function complete() {
  const manifestLines = FAMILIES.flatMap(([fam, names]) =>
    names.map((n) => `${fam}\t${bundle(n)}`),
  );
  const checksummed = [...BINARIES, ...ZIPS, ...MCPB];
  const assets = [
    ...checksummed,
    ...LOOSE,
    "SHASUMS256.txt",
    ...FAMILIES.flatMap(([, names]) => names.map(bundle)),
  ];
  return { manifestLines, checksummed, assets };
}

function run({ assets, manifestLines, checksummed, shasums }) {
  const dir = mkdtempSync(join(tmpdir(), "check-release-assets-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(dir, "assets.txt"), `${assets.join("\n")}\n`);
  // Serves the fixed list for both `gh release view ... --jq` and `gh api ... --jq`.
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash\ncat "${join(dir, "assets.txt")}"\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const sums = join(dir, "SHASUMS256.txt");
  writeFileSync(
    sums,
    shasums ?? `${checksummed.map((n) => `${"0".repeat(64)}  ./x/${n}`).join("\n")}\n`,
  );
  const sigs = join(dir, "signature-manifest.tsv");
  writeFileSync(sigs, manifestLines.length ? `${manifestLines.join("\n")}\n` : "");
  return spawnSync("bash", [SCRIPT, "123456", sums, sigs], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: "o/r" },
  });
}

test("a complete release passes and reports all 19 bundles", () => {
  const r = run(complete());
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /19 cosign bundles/);
});

test("RED case: a release missing all eight native bundles fails", () => {
  const c = complete();
  const assets = c.assets.filter((a) => !NATIVE.map(bundle).includes(a));
  const r = run({ ...c, assets });
  assert.notEqual(
    r.status,
    0,
    "native bundles are not in SHASUMS256.txt; the gate must still catch them",
  );
  for (const n of NATIVE)
    assert.ok((r.stdout + r.stderr).includes(bundle(n)), `names ${bundle(n)}`);
});

test("a release missing a single native bundle fails and names it", () => {
  const c = complete();
  const gone = bundle(NATIVE[3]);
  const r = run({ ...c, assets: c.assets.filter((a) => a !== gone) });
  assert.notEqual(r.status, 0);
  assert.ok((r.stdout + r.stderr).includes(gone));
});

test("a release missing a checksummed artifact's bundle fails", () => {
  const c = complete();
  const gone = bundle(BINARIES[0]);
  const r = run({ ...c, assets: c.assets.filter((a) => a !== gone) });
  assert.notEqual(r.status, 0);
  assert.ok((r.stdout + r.stderr).includes(gone));
});

test("a release missing a checksummed artifact fails", () => {
  const c = complete();
  const r = run({ ...c, assets: c.assets.filter((a) => a !== MCPB[0]) });
  assert.notEqual(r.status, 0);
});

test("a manifest that lost a native family (signing produced 7, not 8) fails on the count", () => {
  const c = complete();
  const manifestLines = c.manifestLines.filter((l) => !l.includes(bundle(NATIVE[0])));
  const r = run({ ...c, manifestLines });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /native/);
});

test("a manifest with an unknown family fails rather than passing vacuously", () => {
  const c = complete();
  const r = run({ ...c, manifestLines: [...c.manifestLines, `surprise\tx.sigstore.json`] });
  assert.notEqual(r.status, 0);
});

test("an empty signature manifest fails", () => {
  const c = complete();
  const r = run({ ...c, manifestLines: [] });
  assert.notEqual(r.status, 0);
});

test("a checksummed artifact whose bundle the manifest does not list fails", () => {
  const c = complete();
  const manifestLines = c.manifestLines.filter((l) => !l.endsWith(`\t${bundle(ZIPS[1])}`));
  // keep the count right by swapping in a duplicate plugin-zip line for the removed one
  manifestLines.push(`plugin-zip\t${bundle(ZIPS[0])}`);
  const r = run({ ...c, manifestLines });
  assert.notEqual(r.status, 0);
});
