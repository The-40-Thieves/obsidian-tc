// VaultBackend — the single filesystem abstraction over vault state (THE-255 lean v1).
//
// One backend serves reads AND writes in both live and headless mode: M1 CRUD already
// writes direct-to-disk via writeNoteAtomic, and that is correct whether Obsidian is open
// (its watcher reconciles) or closed (no index to corrupt). "Live vs headless" is not a
// write-path distinction — it is solely whether the app-action channel is reachable
// (see mode.ts / assertLive). There is no second (REST) CRUD backend.
//
// Writes and deletes fire an inline index-on-write seam (ReindexHook), so the sqlite-vec
// index stays fresh without a watcher; a boot-time reconcile (cli.ts) catches changes made
// while the server was down. ACL stays at the tool layer (callers already enforcePathAcl);
// the backend is caller-agnostic.
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { hardDelete, noteExists, readNote, trashNote, writeNoteAtomic } from "./notes-io";
import { normalizeVaultPath, resolveVaultPath, type WalkEntry, walkVault } from "./paths";

export interface VaultFile {
  path: string;
  type: "file" | "folder";
  size: number;
  mtime: number;
}

/** Vault-state surface. Reads/writes for both modes funnel through this. */
export interface VaultBackend {
  read(path: string): Promise<string>;
  /** Atomic temp-file + rename; fires the index-on-write seam. */
  write(path: string, content: string): Promise<void>;
  /** Trash-aware soft delete (moves to .trash/); fires the index-on-write seam. */
  delete(path: string, opts?: { hard?: boolean }): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Shallow listing of one directory (vault root when `dir` is omitted). */
  list(dir?: string): Promise<string[]>;
  /** Recursive walk, skipping dot-directories (.obsidian/.trash/.git). */
  walk(opts?: { sub?: string; extensions?: string[] }): Promise<VaultFile[]>;
}

/** Index-on-write seam: the backend notifies this after a mutation so the sqlite-vec index
 *  is reindexed inline. Best-effort — the cli-injected impl never throws into the write. */
export interface ReindexHook {
  onWrite?(path: string, content: string): void | Promise<void>;
  onDelete?(path: string): void | Promise<void>;
}

/** Direct-atomic-fs backend — the sole read/write impl, wrapping the existing notes-io +
 *  path-safety primitives, so a headless write is byte-identical to a live one. */
export class FilesystemBackend implements VaultBackend {
  constructor(
    private readonly root: string,
    private readonly reindex: ReindexHook = {},
  ) {}

  async read(path: string): Promise<string> {
    const abs = resolveVaultPath(this.root, path);
    const found = noteExists(abs);
    if (!found.exists || found.type !== "file")
      throw err.noteNotFound(`note not found: ${path}`, { path });
    return readNote(abs).raw;
  }

  async write(path: string, content: string): Promise<void> {
    writeNoteAtomic(resolveVaultPath(this.root, path), content);
    await this.reindex.onWrite?.(normalizeVaultPath(path), content);
  }

  async delete(path: string, opts: { hard?: boolean } = {}): Promise<void> {
    const abs = resolveVaultPath(this.root, path);
    if (!noteExists(abs).exists) throw err.noteNotFound(`note not found: ${path}`, { path });
    if (opts.hard) hardDelete(abs);
    else trashNote(this.root, normalizeVaultPath(path));
    await this.reindex.onDelete?.(normalizeVaultPath(path));
  }

  async exists(path: string): Promise<boolean> {
    return noteExists(resolveVaultPath(this.root, path)).exists;
  }

  async list(dir?: string): Promise<string[]> {
    return walkVault(this.root, { sub: dir, recursive: false, includeFolders: true }).map(
      (e) => e.relPath,
    );
  }

  async walk(opts: { sub?: string; extensions?: string[] } = {}): Promise<VaultFile[]> {
    return walkVault(this.root, { ...opts, recursive: true }).map((e: WalkEntry) => ({
      path: e.relPath,
      type: e.type,
      size: e.size,
      mtime: e.mtime,
    }));
  }
}
