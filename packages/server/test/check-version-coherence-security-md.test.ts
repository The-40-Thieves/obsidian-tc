// Regression proof for THE-562 (P0.3b regressed): SECURITY.md advertised "1.10.x" as supported
// while the shipped package version was 1.11.0, and nothing caught it because SECURITY.md
// appeared in no script and no workflow. scripts/check-version-coherence.mjs now anchors on the
// SECURITY.md supported-version table row. A gate that has never been watched fail is not a gate
// (this repo has been bitten by exactly that), so this test proves the new anchor actually fires
// on a stale row, not just that it passes on the current, already-correct file.
//
// THE-944 review round 1 (F2) added a SECOND "mutate a real repo file, spawn the coherence
// script" proof below (packages/reranker-local/package.json drifting from the lockstep version) —
// deliberately in THIS SAME FILE, not a separate one. The script hardcodes repo-root-relative
// paths, so both proofs mutate real, shared files the SAME script reads together; vitest runs
// separate test FILES in parallel by default, and an earlier draft that split these into two
// files raced for real — one file's "make SECURITY.md stale" window overlapped the other's spawn,
// so ITS run observed SECURITY.md mid-mutation and failed for the wrong reason. Tests within one
// file run in declaration order, not in parallel, which is what actually fixes this — not a
// smaller blast radius, an eliminated one.
//
// The script hardcodes repo-root-relative paths (SECURITY.md, package.json, ...), so there is no
// cwd-injection seam to point it at an isolated fixture tree without faking every file it reads.
// Instead each proof mutates its OWN real file in place for the duration of a single spawned run
// and restores the original content immediately after (belt-and-suspenders: both a try/finally
// around the mutation and an afterEach backstop), so the working tree is left clean even if an
// assertion throws mid-test.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SECURITY_MD = fileURLToPath(new URL("../../../SECURITY.md", import.meta.url));
const RERANKER_LOCAL_PACKAGE_JSON = fileURLToPath(
  new URL("../../reranker-local/package.json", import.meta.url),
);
const SCRIPT = "scripts/check-version-coherence.mjs";

const originalSecurityMd = readFileSync(SECURITY_MD, "utf8");
const originalRerankerLocalPackageJson = readFileSync(RERANKER_LOCAL_PACKAGE_JSON, "utf8");

function runCheck() {
  return spawnSync("node", [SCRIPT], { cwd: REPO_ROOT, encoding: "utf8" });
}

afterEach(() => {
  // Idempotent backstop: re-asserts the original content even if a test's own finally already did.
  writeFileSync(SECURITY_MD, originalSecurityMd);
  writeFileSync(RERANKER_LOCAL_PACKAGE_JSON, originalRerankerLocalPackageJson);
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
    expect(originalSecurityMd).toMatch(supportedRow);
    const stale = originalSecurityMd.replace(supportedRow, "| 9.9.x$1");
    expect(stale).not.toBe(originalSecurityMd);

    writeFileSync(SECURITY_MD, stale);
    try {
      const result = runCheck();
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(
        /FAIL: SECURITY\.md supported-version drift/,
      );
    } finally {
      writeFileSync(SECURITY_MD, originalSecurityMd);
    }
  });
});

// THE-944 review round 1 (F2): packages/reranker-local/package.json rejoined the version lockstep
// scripts/check-version-coherence.mjs enforces (see that script's own comment on the `add(...)`
// call for this package). Without a gate objecting, the package's version could drift from the
// repo's forever — and per F2's own failing scenario, a version that never moves means the
// publish-reranker-local CI job's F3-style already-published preflight finds the SAME version
// already on npm on every release after the owner's one-time first manual publish, and silently
// skips publishing forever.
describe("check-version-coherence.mjs covers packages/reranker-local (THE-944 review round 1, F2)", () => {
  it("passes against the real, currently-in-lockstep reranker-local version", () => {
    const result = runCheck();
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/packages\/reranker-local\/package\.json\s+\d+\.\d+\.\d+/);
    expect(result.stdout).toMatch(/OK: all 8 version strings agree/);
  });

  it("fails when packages/reranker-local/package.json's version drifts from the repo version", () => {
    const pkg = JSON.parse(originalRerankerLocalPackageJson) as { version: string };
    // Sanity check on the fixture itself: if this ever equals the mutated value below, the
    // mutation is a silent no-op and the test would pass for the wrong reason.
    expect(pkg.version).not.toBe("0.0.1-stale");
    const stale = `${JSON.stringify({ ...pkg, version: "0.0.1-stale" }, null, 2)}\n`;
    expect(stale).not.toBe(originalRerankerLocalPackageJson);

    writeFileSync(RERANKER_LOCAL_PACKAGE_JSON, stale);
    try {
      const result = runCheck();
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/FAIL: version drift/);
      expect(`${result.stdout}${result.stderr}`).toContain("0.0.1-stale");
    } finally {
      writeFileSync(RERANKER_LOCAL_PACKAGE_JSON, originalRerankerLocalPackageJson);
    }
  });
});
