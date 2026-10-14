import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { pickTgz } from "./lib/pick-tgz.mjs";

const CLI = fileURLToPath(new URL("./lib/pick-tgz.mjs", import.meta.url));
const BASE = "the-40-thieves-obsidian-tc-embedder-local-";
const root = mkdtempSync(join(tmpdir(), "pick-tgz-"));
after(() => rmSync(root, { recursive: true, force: true }));

function fixture(name, files) {
  // A literal backslash in the directory name is the Windows RUNNER_TEMP shape that a bash glob
  // cannot cross.
  const dir = join(root, name);
  mkdirSync(dir);
  for (const f of files) writeFileSync(join(dir, f), "");
  return dir;
}

describe("pickTgz", () => {
  const files = [
    `${BASE}1.2.3.tgz`,
    `${BASE}linux-x64-1.2.3.tgz`,
    `${BASE}linux-arm64-1.2.3.tgz`,
    `${BASE}win32-x64-1.2.3.tgz`,
  ];

  it("separates the base package from the runtime packages", () => {
    const dir = fixture("a", files);
    assert.equal(pickTgz(dir, BASE), join(dir, `${BASE}1.2.3.tgz`));
    assert.equal(pickTgz(dir, `${BASE}linux-x64-`), join(dir, `${BASE}linux-x64-1.2.3.tgz`));
  });

  it("fails on zero or several matches", () => {
    const dir = fixture("b", [...files, `${BASE}1.2.4.tgz`]);
    assert.throws(() => pickTgz(dir, BASE), /found 2/);
    assert.throws(() => pickTgz(dir, `${BASE}darwin-arm64-`), /found 0/);
  });

  it("works through the CLI in a directory whose name holds a backslash", () => {
    const dir = fixture("d\\e", files);
    const ok = spawnSync(process.execPath, [CLI, dir, `${BASE}win32-x64-`], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout.trim(), join(dir, `${BASE}win32-x64-1.2.3.tgz`));
    const bad = spawnSync(process.execPath, [CLI, dir, `${BASE}darwin-x64-`], { encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /found 0/);
  });
});
