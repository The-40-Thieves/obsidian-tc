// Regression proof for THE-562 (P0.3b regressed): SECURITY.md advertised "1.10.x" as supported
// while the shipped package version was 1.11.0, and nothing caught it because SECURITY.md
// appeared in no script and no workflow. scripts/check-version-coherence.mjs now anchors on the
// SECURITY.md supported-version table row. A gate that has never been watched fail is not a gate
// (this repo has been bitten by exactly that), so this test proves the new anchor actually fires
// on a stale row, not just that it passes on the current, already-correct file.
//
// The script hardcodes repo-root-relative paths (SECURITY.md, README.md, package.json, ...), so
// there is no cwd-injection seam to point it at an isolated fixture tree without faking every file
// it reads. Instead this test mutates the REAL SECURITY.md in place for the duration of a single
// spawned run and restores the original content immediately after (belt-and-suspenders: both a
// try/finally around the mutation and an afterEach backstop), so the working tree is left clean
// even if an assertion throws mid-test.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SECURITY_MD = fileURLToPath(new URL("../../../SECURITY.md", import.meta.url));
const SCRIPT = "scripts/check-version-coherence.mjs";

const original = readFileSync(SECURITY_MD, "utf8");

function runCheck() {
  return spawnSync("node", [SCRIPT], { cwd: REPO_ROOT, encoding: "utf8" });
}

afterEach(() => {
  // Idempotent backstop: re-asserts the original content even if a test's own finally already did.
  writeFileSync(SECURITY_MD, original);
});

describe("check-version-coherence.mjs SECURITY.md supported-version gate (THE-562)", () => {
  it("passes against the real, currently-correct SECURITY.md", () => {
    const result = runCheck();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/SECURITY\.md supported-version OK/);
  });

  it("fails when the supported-version table advertises a stale minor", () => {
    const supportedRow = /\|\s*\d+\.\d+\.x(\s*\|\s*:white_check_mark:\s*\|)/;
    // Sanity check on the fixture itself: if this stops matching, the mutation below is a silent
    // no-op and the test would pass for the wrong reason (never actually staling the row).
    expect(original).toMatch(supportedRow);
    const stale = original.replace(supportedRow, "| 9.9.x$1");
    expect(stale).not.toBe(original);

    writeFileSync(SECURITY_MD, stale);
    try {
      const result = runCheck();
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(
        /FAIL: SECURITY\.md supported-version drift/,
      );
    } finally {
      writeFileSync(SECURITY_MD, original);
    }
  });
});
