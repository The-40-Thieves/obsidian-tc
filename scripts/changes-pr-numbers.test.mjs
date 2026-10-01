import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  fillPrNumbers,
  gitPrOf,
  parseFragment,
  readFragments,
  rollUnreleased,
} from "./lib/changes.mjs";

// Release assembly fills each fragment's `(#N)` from git history, so a PR never commits its own
// number after opening. The fixtures are real repos with merge-queue-shaped history: a PR branch
// merged with `Merge pull request #N from ...`.

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};

const frag = (type, body) => `---\ntype: ${type}\n---\n${body}\n`;

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "chg-pr-"));
  const git = (...args) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
      cwd: dir,
      env: GIT_ENV,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, "changes"));
  writeFileSync(join(dir, "README.md"), "x\n");
  git("add", "-A");
  git("commit", "-q", "-m", "chore: init");
  /** A PR branch with one commit per entry in `files`, merged the way the merge queue does. */
  const mergePr = (n, branch, files, subject = "feat: thing") => {
    git("checkout", "-q", "-b", branch);
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(dir, name), text);
      git("add", "-A");
      git("commit", "-q", "-m", subject);
    }
    git("checkout", "-q", "main");
    git(
      "merge",
      "-q",
      "--no-ff",
      "-m",
      `Merge pull request #${n} from The-40-Thieves/${branch}`,
      branch,
    );
  };
  const commitOnMain = (name, text, subject) => {
    writeFileSync(join(dir, name), text);
    git("add", "-A");
    git("commit", "-q", "-m", subject);
  };
  return { dir, git, mergePr, commitOnMain };
}

function withRepo(fn) {
  const repo = makeRepo();
  try {
    return fn(repo);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
}

test("a fragment without a number gets the PR whose merge commit brought it in", () =>
  withRepo(({ dir, mergePr }) => {
    mergePr(11, "feat/a", { "changes/a.md": frag("Added", "- **A.** did a thing.") });
    const filled = fillPrNumbers(readFragments(dir), gitPrOf(dir));
    assert.equal(filled[0].body, "- **A.** did a thing (#11).");
  }));

test("the fragment's PR is the one that FIRST added it, even when the PR has later commits", () =>
  withRepo(({ dir, mergePr }) => {
    mergePr(12, "feat/b", {
      "changes/b.md": frag("Fixed", "- **B.** fixed."),
      "extra.txt": "later commit in the same PR\n",
    });
    const filled = fillPrNumbers(readFragments(dir), gitPrOf(dir));
    assert.equal(filled[0].body, "- **B.** fixed (#12).");
  }));

test("two fragments from two PRs each get their own number", () =>
  withRepo(({ dir, mergePr }) => {
    mergePr(21, "feat/one", { "changes/one.md": frag("Added", "- **One.** first.") });
    mergePr(22, "feat/two", { "changes/two.md": frag("Fixed", "- **Two.** second.") });
    const filled = fillPrNumbers(readFragments(dir), gitPrOf(dir));
    assert.deepEqual(
      filled.map((f) => f.body),
      ["- **One.** first (#21).", "- **Two.** second (#22)."],
    );
  }));

test("an explicit (#N) is left untouched, including the (#N, closes #M) and period-then-number forms", () =>
  withRepo(({ dir, mergePr }) => {
    mergePr(31, "feat/c", {
      "changes/c.md": frag("Added", "- **C.** x (#7)."),
      "changes/d.md": frag("Added", "- **D.** y (#8, closes #3)."),
      "changes/e.md": frag("Added", "- **E.** z. (#9)"),
    });
    const frags = readFragments(dir);
    const never = () => assert.fail("a cited fragment must not be looked up");
    assert.deepEqual(fillPrNumbers(frags, never), frags);
  }));

test("a multi-line first bullet takes the number at its end; later bullets are untouched", () =>
  withRepo(({ dir, mergePr }) => {
    mergePr(41, "feat/m", {
      "changes/m.md": frag(
        "Added",
        "- **M.** line one\n  continues here.\n- **N.** second bullet.",
      ),
    });
    const [f] = fillPrNumbers(readFragments(dir), gitPrOf(dir));
    assert.equal(f.body, "- **M.** line one\n  continues here (#41).\n- **N.** second bullet.");
  }));

test("a bullet without a final period gets ` (#N)` appended", () => {
  const [f] = fillPrNumbers(
    [parseFragment(frag("Added", "- **P.** no period"), "changes/p.md")],
    () => "5",
  );
  assert.equal(f.body, "- **P.** no period (#5)");
});

test("a squash-merged fragment takes the trailing (#N) of its own commit subject", () =>
  withRepo(({ dir, commitOnMain }) => {
    commitOnMain("changes/s.md", frag("Fixed", "- **S.** squashed."), "fix: squashed thing (#51)");
    const [f] = fillPrNumbers(readFragments(dir), gitPrOf(dir));
    assert.equal(f.body, "- **S.** squashed (#51).");
  }));

test("an orphan fragment (no PR) makes the release refuse and names the file", () =>
  withRepo(({ dir, mergePr, commitOnMain }) => {
    mergePr(61, "feat/ok", { "changes/ok.md": frag("Added", "- **Ok.** fine.") });
    commitOnMain("changes/orphan.md", frag("Added", "- **Orphan.** direct."), "chore: direct push");
    writeFileSync(
      join(dir, "changes", "uncommitted.md"),
      frag("Added", "- **U.** never committed."),
    );
    assert.throws(
      () => fillPrNumbers(readFragments(dir), gitPrOf(dir)),
      (err) =>
        /changes\/orphan\.md/.test(err.message) &&
        /changes\/uncommitted\.md/.test(err.message) &&
        !/changes\/ok\.md/.test(err.message),
    );
  }));

test("a fragment whose adding commit has no parent (root or shallow boundary) is refused, not guessed", () => {
  const dir = mkdtempSync(join(tmpdir(), "chg-pr-"));
  try {
    const git = (...args) =>
      execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: dir, env: GIT_ENV });
    git("init", "-q", "-b", "main");
    mkdirSync(join(dir, "changes"));
    writeFileSync(join(dir, "changes", "r.md"), frag("Added", "- **R.** root."));
    git("add", "-A");
    git("commit", "-q", "-m", "feat: root (#5)");
    assert.throws(() => fillPrNumbers(readFragments(dir), gitPrOf(dir)), /changes\/r\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the assembled release body cites every filled PR, so the coverage gate (body.includes) passes", () =>
  withRepo(({ dir, mergePr }) => {
    mergePr(71, "feat/x", { "changes/x.md": frag("Added", "- **X.** x.") });
    mergePr(72, "fix/y", { "changes/y.md": frag("Fixed", "- **Y.** y.") });
    const cl = "# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n- x\n";
    const filled = fillPrNumbers(readFragments(dir), gitPrOf(dir));
    const { body } = rollUnreleased(cl, filled, "1.1.0", "2026-02-02");
    for (const n of ["71", "72"]) assert.ok(body.includes(`#${n}`), `body cites #${n}`);
  }));

test("when every fragment already has its number the roll is byte-identical to the unfilled roll", () => {
  const cl = "# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n- x\n";
  const frags = [
    parseFragment(frag("Added", "- **A.** a (#1)."), "changes/a.md"),
    parseFragment(frag("Fixed", "- **B.** b (#2, closes #3)."), "changes/b.md"),
  ];
  const filled = fillPrNumbers(frags, () => assert.fail("no lookup expected"));
  assert.equal(
    rollUnreleased(cl, filled, "1.1.0", "2026-02-02").text,
    rollUnreleased(cl, frags, "1.1.0", "2026-02-02").text,
  );
});
