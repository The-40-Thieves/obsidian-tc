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

function guard(script) {
  const r = spawnSync(process.execPath, [GUARD, process.execPath, "-e", script], {
    encoding: "utf8",
    env: { ...process.env, TMPDIR: base, TMP: base, TEMP: base },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const MKDTEMP = `const {mkdtempSync}=require("node:fs");const {tmpdir}=require("node:os");const {join}=require("node:path");`;

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

  it("does not leave its own root behind, leak or not", () => {
    const r = guard(`${MKDTEMP}mkdtempSync(join(tmpdir(),"leak-"));`);
    assert.equal(r.code, 1);
    assert.deepEqual(
      readdirSync(base).filter((n) => n.startsWith("obtc-guard-")),
      [],
    );
  });
});
