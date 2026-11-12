// Every place that declares this project's own licence must say Apache-2.0, and every published
// package must ship the same LICENSE and NOTICE as the repo root. Apache-2.0 §4(d) requires the
// NOTICE file to travel with redistributions, and npm does not include a NOTICE file unless
// `files` names it (it only auto-includes LICENSE, README and package.json).
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPDX = "Apache-2.0";
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const readJson = (p) => JSON.parse(read(p));

const rootLicense = read("LICENSE");
const rootNotice = read("NOTICE");

const packageDirs = readdirSync(join(ROOT, "packages"), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(ROOT, "packages", d.name, "package.json")))
  .map((d) => `packages/${d.name}`);

test("the root LICENSE is the Apache License 2.0", () => {
  assert.match(rootLicense, /^\s*Apache License\s*\n\s*Version 2\.0, January 2004/);
  assert.match(rootLicense, /END OF TERMS AND CONDITIONS/);
});

test("the root NOTICE names the project and records the AGPL boundary", () => {
  assert.match(rootNotice, /Apache License, Version 2\.0/);
  assert.match(rootNotice, /AGPL-3\.0-only/);
});

test("the workspace has packages to check (non-empty floor)", () => {
  assert.ok(packageDirs.length >= 6, `found only ${packageDirs.length} packages`);
});

test("root and every package declare Apache-2.0", () => {
  assert.equal(readJson("package.json").license, SPDX);
  for (const dir of packageDirs) {
    assert.equal(readJson(`${dir}/package.json`).license, SPDX, `${dir}/package.json`);
  }
});

test("every published package ships the root LICENSE and NOTICE byte for byte", () => {
  for (const dir of packageDirs) {
    const manifest = readJson(`${dir}/package.json`);
    if (manifest.private) continue;
    assert.equal(read(`${dir}/LICENSE`), rootLicense, `${dir}/LICENSE differs from the root`);
    assert.equal(read(`${dir}/NOTICE`), rootNotice, `${dir}/NOTICE differs from the root`);
    if (Array.isArray(manifest.files)) {
      assert.ok(manifest.files.includes("LICENSE"), `${dir} files[] omits LICENSE`);
      assert.ok(manifest.files.includes("NOTICE"), `${dir} files[] omits NOTICE`);
    }
  }
});

test("the crate, bundle and plugin manifests declare Apache-2.0", () => {
  assert.match(read("packages/native/Cargo.toml"), /^license = "Apache-2\.0"$/m);
  assert.equal(readJson("mcpb/manifest.json").license, SPDX);
  assert.equal(readJson("plugins/reliquary-tc/.claude-plugin/plugin.json").license, SPDX);
});

test("no workflow labels a published image with the old licence", () => {
  for (const wf of ["publish.yml", "release-image.yml"]) {
    const text = read(`.github/workflows/${wf}`);
    assert.doesNotMatch(text, /image\.licenses=AGPL/, wf);
    assert.match(text, /image\.licenses=Apache-2\.0/, wf);
  }
});
