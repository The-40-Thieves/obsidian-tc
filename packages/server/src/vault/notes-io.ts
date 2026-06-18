// Filesystem note IO. Writes are atomic (temp file + rename) so a crash never
// leaves a half-written note and Obsidian's watcher sees a single replace.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { contentHash } from "./paths";

export interface NoteStat {
  size: number;
  mtime: string;
  ctime: string;
}

export function noteExists(abs: string): { exists: boolean; type?: "file" | "folder" } {
  if (!existsSync(abs)) return { exists: false };
  try {
    return { exists: true, type: statSync(abs).isDirectory() ? "folder" : "file" };
  } catch {
    return { exists: false };
  }
}

export function readNote(abs: string): { raw: string; hash: string } {
  const raw = readFileSync(abs, "utf8");
  return { raw, hash: contentHash(raw) };
}

export function writeNoteAtomic(abs: string, content: string, createDirs = true): void {
  if (createDirs) mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, abs);
}

export function statNote(abs: string): NoteStat | null {
  try {
    const s = statSync(abs);
    return {
      size: s.size,
      mtime: new Date(s.mtimeMs).toISOString(),
      ctime: new Date(s.ctimeMs).toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * Soft-delete: move a note into the vault's `.trash/` mirror (Obsidian trash).
 * Returns the vault-relative trash path. A name collision (deleting two notes
 * with the same relative path) is disambiguated with a ` (n)` suffix rather than
 * clobbering the earlier trashed copy — renameSync over an existing file throws
 * EPERM on Windows, so we never rename onto an occupied destination.
 */
export function trashNote(root: string, relPath: string): string {
  const dot = relPath.lastIndexOf(".");
  const slash = relPath.lastIndexOf("/");
  const stem = dot > slash ? relPath.slice(0, dot) : relPath;
  const ext = dot > slash ? relPath.slice(dot) : "";
  let candidate = relPath;
  for (let i = 1; existsSync(join(root, ".trash", candidate)); i++)
    candidate = `${stem} (${i})${ext}`;
  const dest = join(root, ".trash", candidate);
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(join(root, relPath), dest);
  return `.trash/${candidate}`;
}

export function hardDelete(abs: string): void {
  rmSync(abs, { force: true });
}
