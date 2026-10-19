// The temp-leak wrapper must fail on a leaker (RED) and pass on a tidy command (GREEN). A guard
// tested only on passing cases is the shape that ships silently inert, so the leaker cases use the
// directory names that actually piled up in /tmp on 2026-09-30.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const GUARD = fileURLToPath(new URL("./with-tmp-guard.mjs", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "tmp-guard-test-"));
after(() => rmSync(base, { recursive: true, force: true }));

function guard(script, extraEnv = {}) {
  const r = spawnSync(process.execPath, [GUARD, process.execPath, "-e", script], {
    encoding: "utf8",
    env: { ...process.env, TMPDIR: base, TMP: base, TEMP: base, ...extraEnv },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const MKDTEMP = `const {mkdtempSync}=require("node:fs");const {tmpdir}=require("node:os");const {join}=require("node:path");`;
const GIT_CONFIG_READ = `const {spawnSync}=require("node:child_process");const cfg=(k)=>spawnSync("git",["config","--get",k],{encoding:"utf8"}).stdout.trim();`;

describe("with-tmp-guard", () => {
  for (const prefix of [
    "check-redos-nested-",
    "where-symbol-",
    "check-release-assets-",
    "verify-",
  ]) {
    it(`fails and names a leaked ${prefix}* directory`, () => {
      const r = guard(`${MKDTEMP}mkdtempSync(join(tmpdir(), ${JSON.stringify(prefix)}));`);
      assert.equal(r.code, 1);
      assert.match(r.out, new RegExp(`\\[tmp-guard\\] 1 temp entry[\\s\\S]*${prefix}`));
    });
  }

  it("passes a command that removes what it creates", () => {
    const r = guard(
      `${MKDTEMP}const d=mkdtempSync(join(tmpdir(),"tidy-"));require("node:fs").rmSync(d,{recursive:true});`,
    );
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.out, /tmp-guard/);
  });

  it("propagates the child's own failure code ahead of the leak verdict", () => {
    const r = guard(`${MKDTEMP}mkdtempSync(join(tmpdir(),"x-"));process.exit(7)`);
    assert.equal(r.code, 7);
  });

  it("child env disables git auto maintenance (maintenance.auto=false)", () => {
    const r = guard(
      `${GIT_CONFIG_READ}process.stdout.write(JSON.stringify(cfg("maintenance.auto")));`,
    );
    assert.equal(r.code, 0);
    assert.equal(r.out, '"false"');
  });

  it("child env appends to an existing GIT_CONFIG_COUNT instead of overwriting it", () => {
    const r = guard(
      `${GIT_CONFIG_READ}process.stdout.write(JSON.stringify({count:process.env.GIT_CONFIG_COUNT,abbrev:cfg("core.abbrev"),maint:cfg("maintenance.auto")}));`,
      { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.abbrev", GIT_CONFIG_VALUE_0: "12" },
    );
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), { count: "2", abbrev: "12", maint: "false" });
  });

  it("the env helper treats a missing or non-numeric GIT_CONFIG_COUNT as 0", async () => {
    const { withGitMaintenanceOff } = await import("./with-tmp-guard.mjs");
    assert.deepEqual(withGitMaintenanceOff({}), {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "maintenance.auto",
      GIT_CONFIG_VALUE_0: "false",
    });
    assert.equal(
      withGitMaintenanceOff({ GIT_CONFIG_COUNT: "junk" }).GIT_CONFIG_KEY_0,
      "maintenance.auto",
    );
  });

  it("applying the maintenance setting twice leaves exactly one maintenance.auto entry", async () => {
    const { withGitMaintenanceOff } = await import("./with-tmp-guard.mjs");
    const once = withGitMaintenanceOff({});
    assert.deepEqual(withGitMaintenanceOff(once), once);
    assert.deepEqual(withGitMaintenanceOff({ ...once }), once);
  });

  it("a child git commit runs no maintenance run (the detached child that outlived the fixture)", () => {
    const r = guard(
      `const {spawnSync}=require("node:child_process");const {mkdtempSync,writeFileSync}=require("node:fs");const {tmpdir}=require("node:os");const {join}=require("node:path");` +
        `const d=mkdtempSync(join(tmpdir(),"trace-repo-"));` +
        `const env={...process.env,GIT_AUTHOR_NAME:"t",GIT_AUTHOR_EMAIL:"t@t",GIT_COMMITTER_NAME:"t",GIT_COMMITTER_EMAIL:"t@t"};` +
        `spawnSync("git",["init","-q",d],{env});writeFileSync(join(d,"f"),"x");spawnSync("git",["-C",d,"add","f"],{env});` +
        `const c=spawnSync("git",["-C",d,"commit","-q","-m","m"],{encoding:"utf8",env:{...env,GIT_TRACE:"1"}});` +
        `require("node:fs").rmSync(d,{recursive:true,force:true});` +
        `process.stdout.write(JSON.stringify({code:c.status,maintenance:/maintenance run/.test(c.stderr)}));`,
    );
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), { code: 0, maintenance: false });
  });

  it("does not leave its own root behind, leak or not", () => {
    const r = guard(`${MKDTEMP}mkdtempSync(join(tmpdir(),"leak-"));`);
    assert.equal(r.code, 1);
    assert.deepEqual(
      readdirSync(base).filter((n) => n.startsWith("obtc-guard-")),
      [],
    );
  });
});
