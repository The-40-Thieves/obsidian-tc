// THE-1124 — walk an external import directory (basic-memory's notes/, a Claude Code memory
// checkout) and return its files, refusing anything the write-path equivalent (vault/paths.ts)
// would refuse. Per [[feedback-delete-path-as-strict-as-write-path]] and
// [[reference-two-aliases-symlink-and-hardlink]]: a NEW read path over caller-supplied files must
// reuse the repo's existing containment primitive, not re-derive one, and must guard BOTH alias
// shapes (symlink at the walk, hard link at the read) rather than only the one an ad hoc check
// happens to catch.
//
// `resolveVaultPathChecked` (vault/paths.ts) is generic path-safety, not vault-specific: byte-level
// traversal guard (absolute / `..` rejection) plus a realpath containment check that canonicalizes
// both the root and the deepest existing segment of the target through symlinks. Reused here
// verbatim with the import directory standing in for "vault root" — the guarantee is identical.
import { type Dirent, readdirSync } from "node:fs";
import { join } from "node:path";
import { readNote } from "../vault/notes-io";
import { resolveVaultPathChecked } from "../vault/paths";
import type { SkippedFile } from "./types";

export interface WalkedFile {
  /** Forward-slash path relative to `root`. */
  sourcePath: string;
  raw: string;
}

export interface WalkResult {
  files: WalkedFile[];
  skipped: SkippedFile[];
}

/**
 * Resolve one entry (already known to be a non-symlinked, non-directory Dirent) against the
 * import root, refusing a path that escapes it. Exported separately from walkImportDir so a
 * containment refusal can be exercised directly (an operator can never make readdirSync produce
 * a literal `..` segment, so the walk itself never reaches this branch — the escape case is
 * reachable only through a symlinked directory, which the walk refuses one layer up; this
 * function is the unit the escape guarantee actually lives in, and is tested at that layer).
 */
export function checkedImportPath(root: string, relPath: string): string {
  return resolveVaultPathChecked(root, relPath).abs;
}

/** Walk `root` for files matching `extensions` (case-insensitive, e.g. [".md"]), skipping
 *  dot-directories/files and refusing every symlink and hard link by name (reported, not
 *  silently dropped — the caller's dry-run table needs the reason). */
export function walkImportDir(root: string, opts: { extensions?: string[] } = {}): WalkResult {
  const exts = opts.extensions?.map((e) => e.toLowerCase());
  const files: WalkedFile[] = [];
  const skipped: SkippedFile[] = [];

  const walk = (dir: string, prefix: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const name = e.name;
      if (name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${name}` : name;
      const abs = join(dir, name);
      // Dirent.isSymbolicLink() reflects the entry itself (readdirSync does not follow it) — the
      // same walk-level guard walkVault (vault/paths.ts) applies, refusing the alias before any
      // open() would silently follow it through.
      if (e.isSymbolicLink()) {
        skipped.push({ sourcePath: rel, reason: "refused: symlink" });
        continue;
      }
      if (e.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!e.isFile()) continue;
      if (exts && !exts.some((x) => name.toLowerCase().endsWith(x))) continue;
      let checkedAbs: string;
      try {
        checkedAbs = checkedImportPath(root, rel);
      } catch {
        skipped.push({ sourcePath: rel, reason: "refused: path escapes the import root" });
        continue;
      }
      // readNote (vault/notes-io.ts) — never a hand-rolled readFileSync. It fstats the OPEN fd
      // (check-and-use, not TOCTOU) and refuses nlink > 1: the hard-link alias
      // [[reference-two-aliases-symlink-and-hardlink]] documents, which isFile()/lstat both read as
      // an ordinary regular file and so cannot catch on their own.
      let raw: string;
      try {
        raw = readNote(checkedAbs).raw;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isHardLink = /hard-linked|inode aliasing/i.test(msg);
        skipped.push({
          sourcePath: rel,
          reason: isHardLink ? "refused: hard link" : `unreadable: ${msg}`,
        });
        continue;
      }
      files.push({ sourcePath: rel, raw });
    }
  };

  walk(root, "");
  files.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
  skipped.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
  return { files, skipped };
}
