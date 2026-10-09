// `git_commit` binds its confirmation to `gitCommitState` and returns that fingerprint (`state_fp`) to
// the caller. It read `.git/HEAD`, the ref, `packed-refs`, `commondir` and the index with a raw
// readFileSync, so a `.git` file that is a hard link (or a symlink) to a note the caller may not read
// made the fingerprint a function of that note's content: a guessable-content oracle. Every metadata
// file now goes through the opened-fd guard (readFileChecked: nlink > 1 and non-regular refused), and
// the state is refused rather than fingerprinted from it. Runs in the native-loaded CI step too.

import { linkSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitCommitState } from "../src/vault/git-state";
import { makeTempDir, rmTemp } from "./tmp";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

describe("gitCommitState reads git metadata through the single-link guard", () => {
  let root: string;
  let git: string;
  beforeEach(() => {
    root = makeTempDir("obtc-gitstate-");
    git = join(root, ".git");
    mkdirSync(join(git, "refs", "heads"), { recursive: true });
    mkdirSync(join(root, "private"), { recursive: true });
    writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(git, "refs", "heads", "main"), `${SHA_A}\n`);
  });
  afterEach(() => rmTemp(root));

  it("positive control: derived from HEAD and its ref, and moves with the ref", () => {
    const before = gitCommitState(root);
    expect(gitCommitState(root)).toBe(before);
    writeFileSync(join(git, "refs", "heads", "main"), `${SHA_B}\n`);
    expect(gitCommitState(root)).not.toBe(before);
  });

  it("a vault with no repo is still the stable state `absent`", () => {
    const bare = makeTempDir("obtc-gitstate-bare-");
    try {
      expect(gitCommitState(bare)).toBe(gitCommitState(bare));
    } finally {
      rmTemp(bare);
    }
  });

  /** Make `.git/<rel>` an alias of an ordinary note the caller could not otherwise read. */
  const plant = (rel: string, body: string, how: "hard" | "sym"): void => {
    const secret = join(root, "private", "secret.txt");
    writeFileSync(secret, body);
    const target = join(git, rel);
    mkdirSync(dirname(target), { recursive: true });
    rmSync(target, { force: true });
    if (how === "hard") linkSync(secret, target);
    else symlinkSync(secret, target);
  };

  it.each([
    ["HEAD", "ref: refs/heads/main\n"],
    ["refs/heads/main", `${SHA_B}\n`],
    ["packed-refs", `${SHA_B} refs/heads/other\n`],
    ["commondir", ".\n"],
  ] as const)("refuses a hard-linked .git/%s and never derives the state from it", (rel, body) => {
    // packed-refs is consulted only when the loose ref is missing
    if (rel === "packed-refs") rmSync(join(git, "refs", "heads", "main"));
    plant(rel, body, "hard");
    expect(() => gitCommitState(root)).toThrow(/hard-link|inode|safe open refused|not a regular/i);
  });

  it("refuses a hard-linked .git/index", () => {
    writeFileSync(join(git, "index"), "");
    plant("index", "DIRC", "hard");
    expect(() => gitCommitState(root)).toThrow(/hard-link|inode|safe open refused|not a regular/i);
  });

  it("a hard-linked worktree `.git` pointer file is refused, not read as `absent`", () => {
    const wt = makeTempDir("obtc-gitstate-wt-");
    try {
      const secret = join(root, "private", "pointer.txt");
      writeFileSync(secret, `gitdir: ${git}\n`);
      linkSync(secret, join(wt, ".git"));
      expect(() => gitCommitState(wt)).toThrow(/hard-link|inode|safe open refused/i);
    } finally {
      rmTemp(wt);
    }
  });

  it("refuses a symlinked .git/HEAD", () => {
    plant("HEAD", "ref: refs/heads/main\n", "sym");
    expect(() => gitCommitState(root)).toThrow();
  });

  it("two different hard-linked HEAD contents never yield two different fingerprints", () => {
    plant("HEAD", SHA_A, "hard");
    const outcome = (): string => {
      try {
        return gitCommitState(root);
      } catch (e) {
        return `refused:${(e as Error).message.split(":")[0]}`;
      }
    };
    const one = outcome();
    writeFileSync(join(root, "private", "secret.txt"), SHA_B);
    expect(outcome()).toBe(one);
  });
});
