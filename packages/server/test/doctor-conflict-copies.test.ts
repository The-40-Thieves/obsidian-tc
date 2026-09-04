// THE-939 (GH #881) — install.conflict-copies: warns when a sync service (iCloud, Dropbox,
// Syncthing) has written a conflict-copy sibling into the install directory.
//
// Fixtures build a real temp directory tree rather than mocking `readdirSync` — the check's own
// job is the walk (skip node_modules/.git, bound depth and file count, never follow symlinks), and
// that behaviour is only honestly exercised against a real filesystem.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { conflictCopiesCheck, resolveInstallRoot } from "../src/doctor/conflict-copies";
import { rmTemp } from "./tmp";

const ctx = { serverVersion: "test" };

const tmpDirs: string[] = [];
const tmpDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "the939-"));
  tmpDirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmTemp(d);
    } catch {
      // Best-effort: a leaked dir is cheaper than a teardown failure.
    }
  }
});

/** Write `content` at `relPath` under `root`, creating parent directories as needed. */
function writeFixture(root: string, relPath: string, content = ""): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

describe("THE-939 install.conflict-copies", () => {
  it("WARNS and names exactly the four conflict copies, ignoring the decoys", async () => {
    const root = tmpDir();
    // The four that must match.
    writeFixture(root, "src/cli 2.ts");
    writeFixture(root, "src/config.schema 2.ts");
    writeFixture(root, "a (conflicted copy 2026-09-02).ts");
    writeFixture(root, "b.sync-conflict-20260902-123456-ABCDEF.ts");
    // Decoys that must NOT match the patterns.
    writeFixture(root, "v2.ts");
    writeFixture(root, "file2.ts");
    // Decoys that WOULD match the pattern but live in a skipped directory.
    writeFixture(root, "node_modules/x 2.ts");
    writeFixture(root, ".git/x 2.ts");

    const r = await conflictCopiesCheck({ installRoot: root }).run(ctx);

    expect(r.status).toBe("warning");
    const matches = r.details?.matches;
    expect(Array.isArray(matches) ? [...matches].sort() : matches).toEqual(
      [
        "a (conflicted copy 2026-09-02).ts",
        "b.sync-conflict-20260902-123456-ABCDEF.ts",
        "src/cli 2.ts",
        "src/config.schema 2.ts",
      ].sort(),
    );
    expect(r.remediation).toBeTruthy();
    expect(r.issues?.length).toBe(4);
  });

  it("is OK on a clean tree with no conflict copies", async () => {
    const root = tmpDir();
    writeFixture(root, "src/cli.ts");
    writeFixture(root, "v2.ts");
    writeFixture(root, "file2.ts");

    const r = await conflictCopiesCheck({ installRoot: root }).run(ctx);
    expect(r.status).toBe("ok");
    expect(r.details?.matches).toBeUndefined();
  });

  it("reports not-applicable, never a false OK, when no install root resolved", async () => {
    const r = await conflictCopiesCheck({ installRoot: undefined }).run(ctx);
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("not applicable");
  });

  it("reports truncation when the walk hits the file cap", async () => {
    const root = tmpDir();
    for (let i = 0; i < 5; i++) writeFixture(root, `file-${i}.txt`);

    const r = await conflictCopiesCheck({ installRoot: root, maxFiles: 3 }).run(ctx);
    expect(r.details?.truncated).toBeTruthy();
    expect(String(r.details?.truncated)).toContain("3");
  });

  it("does not descend past the depth bound", async () => {
    const root = tmpDir();
    // depth 0 is root itself; a file at depth 3 is well within any sane bound.
    writeFixture(root, "a/b/c/deep 2.ts");
    const shallow = await conflictCopiesCheck({ installRoot: root, maxDepth: 1 }).run(ctx);
    expect(shallow.status).toBe("ok");

    const deep = await conflictCopiesCheck({ installRoot: root, maxDepth: 8 }).run(ctx);
    expect(deep.status).toBe("warning");
  });

  it("never follows a symlinked directory", async () => {
    const root = tmpDir();
    const outside = tmpDir();
    writeFixture(outside, "linked 2.ts");
    try {
      symlinkSync(outside, join(root, "linked-dir"), "dir");
    } catch {
      // Symlink creation can fail without elevated privileges on some Windows runners — skip
      // rather than fail the suite over an environment limitation unrelated to this check.
      return;
    }
    const r = await conflictCopiesCheck({ installRoot: root }).run(ctx);
    expect(r.status).toBe("ok");
  });

  it("normalises Windows path separators in reported paths", async () => {
    const root = tmpDir();
    writeFixture(root, "src/cli 2.ts");
    const r = await conflictCopiesCheck({ installRoot: root }).run(ctx);
    const matches = (r.details?.matches ?? []) as string[];
    for (const m of matches) {
      expect(m).not.toContain(sep === "/" ? "\\" : sep);
      expect(m.includes("/") || !m.includes(sep)).toBe(true);
    }
    expect(matches).toContain("src/cli 2.ts");
  });
});

// Fix round 1 (PR #900 review, HIGH finding): `dist` was unconditionally skipped, which made the
// check walk an npm install's root (files: ["dist", ...] — no `src` ships at all) and find nothing
// to inspect, ever. Corrected rule: `dist` is skipped ONLY when `installRoot/src` exists (a source
// checkout); otherwise `dist` is walked like any other directory.
describe("THE-939 fix round 1 — dist is skipped only in a source checkout", () => {
  it("(a) npm-install layout (no src/): a conflict copy under dist/ IS reported", async () => {
    const root = tmpDir();
    // Mirrors packages/server/package.json's real "files": ["dist", ...] shape — no src ships.
    writeFixture(root, "package.json", JSON.stringify({ name: "obsidian-tc" }));
    writeFixture(root, "dist/cli.js");
    writeFixture(root, "dist/cli 2.js");

    const r = await conflictCopiesCheck({ installRoot: root }).run(ctx);
    expect(r.status).toBe("warning");
    expect(r.details?.matches).toEqual(["dist/cli 2.js"]);
  });

  it("(b) source checkout (src/ present): dist/x 2.js is NOT reported, src/x 2.ts IS", async () => {
    const root = tmpDir();
    writeFixture(root, "src/index.ts");
    writeFixture(root, "dist/x 2.js");
    writeFixture(root, "src/x 2.ts");

    const r = await conflictCopiesCheck({ installRoot: root }).run(ctx);
    expect(r.status).toBe("warning");
    expect(r.details?.matches).toEqual(["src/x 2.ts"]);
  });

  it("(c) details.applicable is 'false' on the not-applicable path, 'true' otherwise", async () => {
    const notApplicable = await conflictCopiesCheck({ installRoot: undefined }).run(ctx);
    expect(notApplicable.details?.applicable).toBe("false");

    const root = tmpDir();
    const applicable = await conflictCopiesCheck({ installRoot: root }).run(ctx);
    expect(applicable.details?.applicable).toBe("true");
  });
});

describe("THE-939 resolveInstallRoot", () => {
  it("resolves to the packages/server package root from a source checkout", () => {
    const root = resolveInstallRoot();
    expect(root).toBeDefined();
    expect(root?.endsWith(`packages${sep}server`)).toBe(true);
  });
});
