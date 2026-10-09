import { existsSync, lstatSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { fingerprintTargets } from "../elicit-drift";
import { argsHash } from "../hash";
import { readFileChecked } from "./notes-io";

/** Read one git metadata file through the opened-fd guard every vault file read uses (a hard link or
 *  a non-regular file is refused), and refuse a symlink outright. `state_fp` goes back to the caller,
 *  so a `.git` file that aliased a note the caller may not read would otherwise make it a function of
 *  that note's content. Refusing is the contract: a state that cannot be read is never fingerprinted
 *  from something else. */
function readGitBytes(path: string): Buffer {
  if (lstatSync(path).isSymbolicLink())
    throw err.aclDenied("refusing to read symlinked git metadata", { path });
  return readFileChecked(path);
}

const readGit = (path: string): string => readGitBytes(path).toString("utf8");

/** Resolve a vault's git dir: `.git` directory, or the `gitdir:` pointer file of a worktree. */
function gitDirOf(root: string): string | null {
  const dot = join(root, ".git");
  try {
    if (statSync(dot).isDirectory()) return dot;
  } catch {
    return null;
  }
  // Outside the try: a pointer file that is refused (hard link, symlink) must surface, not read as "no repo".
  const m = /^gitdir:\s*(.+)$/m.exec(readGit(dot));
  return m?.[1] ? resolve(root, m[1].trim()) : null;
}

/** The commit HEAD points at, `unborn` before the first commit. Reads refs directly rather than
 *  spawning git: a vault's `.git/config` is not trusted to run programs (core.fsmonitor). */
function headOf(gitDir: string): string {
  const head = readGit(join(gitDir, "HEAD")).trim();
  const ref = head.startsWith("ref:") ? head.slice(4).trim() : "";
  if (!ref) return head;
  const common = existsSync(join(gitDir, "commondir"))
    ? resolve(gitDir, readGit(join(gitDir, "commondir")).trim())
    : gitDir;
  for (const dir of [gitDir, common]) {
    if (existsSync(join(dir, ref))) return readGit(join(dir, ref)).trim();
  }
  const packed = existsSync(join(common, "packed-refs"))
    ? readGit(join(common, "packed-refs"))
    : "";
  return (
    packed
      .split("\n")
      .find((l) => l.endsWith(` ${ref}`))
      ?.split(" ")[0] ?? "unborn"
  );
}

/** Index entries (path, mode, blob id, stage, extended flags) of a v2/v3 index, or null for any
 *  other version. Stat data is left out on purpose: `git status` refreshes it without changing
 *  what is staged, and that must not read as drift. */
function stagedEntries(index: Buffer): string[] | null {
  if (index.length < 12 || index.toString("latin1", 0, 4) !== "DIRC") return null;
  const version = index.readUInt32BE(4);
  if (version !== 2 && version !== 3) return null;
  const count = index.readUInt32BE(8);
  const out: string[] = [];
  let at = 12;
  for (let i = 0; i < count; i++) {
    if (at + 62 > index.length) return null;
    const flags = index.readUInt16BE(at + 60);
    const extended = version === 3 && (flags & 0x4000) !== 0;
    const ext = extended ? index.readUInt16BE(at + 62) : 0;
    const nameAt = at + 62 + (extended ? 2 : 0);
    const end = index.indexOf(0, nameAt);
    if (end < 0) return null;
    const mode = index.readUInt32BE(at + 24).toString(8);
    const blob = index.toString("hex", at + 40, at + 60);
    out.push(
      `${index.toString("utf8", nameAt, end)}\0${mode}\0${blob}\0${(flags >> 12) & 3}\0${ext}`,
    );
    at += Math.ceil((nameAt - at + (end - nameAt) + 1) / 8) * 8;
  }
  return out;
}

/**
 * The state a `git commit` in this vault is about: what HEAD points at and what is staged. A vault
 * with no repo of its own (the bridge's repo lives on another machine) is the stable state
 * `absent`, so the binding then covers only what this host can see.
 */
export function gitCommitState(root: string): string {
  const gitDir = gitDirOf(root);
  if (!gitDir) return argsHash("git", { repo: "absent" });
  const indexPath = join(gitDir, "index");
  if (!existsSync(indexPath)) return argsHash("git", { head: headOf(gitDir), index: "none" });
  const staged = stagedEntries(readGitBytes(indexPath));
  return argsHash("git", {
    head: headOf(gitDir),
    // An index this parser does not read (v4) falls back to the file itself: stricter, never looser.
    index: staged ?? fingerprintTargets(dirname(indexPath), ["index"]),
  });
}
