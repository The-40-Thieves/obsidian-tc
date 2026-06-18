// Path safety + filesystem helpers shared by every path-based tool.
// All vault access funnels through resolveVaultPath: the only place that turns a
// caller-supplied vault-relative path into an absolute filesystem path, with a
// traversal/containment guard. Nothing else should join paths against the root.
import { createHash } from "node:crypto";
import { type Dirent, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { err } from "@obsidian-tc/shared";

/** Full SHA-256 hex of UTF-8 content. Used for content_hash / CAS (prev_hash). */
export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Normalize a vault-relative path to forward-slash form with `.`/empty segments
 * collapsed. Rejects absolute paths and any `..` segment -> path_invalid.
 * Returns "" for the vault root (used by directory-scoped tools).
 */
export function normalizeVaultPath(relPath: string): string {
  const unified = relPath.replace(/\\/g, "/");
  if (unified.startsWith("/") || /^[A-Za-z]:\//.test(unified))
    throw err.pathInvalid("absolute paths are not allowed", { path: relPath });
  const parts = unified.split("/");
  if (parts.some((p) => p === ".."))
    throw err.pathInvalid("path traversal is not allowed", { path: relPath });
  return parts.filter((p) => p !== "" && p !== ".").join("/");
}

/**
 * Resolve a vault-relative path to an absolute filesystem path, guaranteeing the
 * result stays within the vault root (defends against symlink/normalization
 * escapes that slip past the byte-level guard). Throws path_invalid otherwise.
 */
export function resolveVaultPath(vaultRoot: string, relPath: string): string {
  const clean = normalizeVaultPath(relPath);
  const root = resolve(vaultRoot);
  const abs = clean === "" ? root : resolve(root, clean);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw err.pathInvalid("path escapes the vault root", { path: relPath });
  return abs;
}

function statSafe(abs: string): { size: number; mtimeMs: number; ctimeMs: number } | null {
  try {
    const s = statSync(abs);
    return { size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs };
  } catch {
    return null;
  }
}

export interface WalkEntry {
  relPath: string;
  type: "file" | "folder";
  size: number;
  mtime: number;
}

/**
 * Walk a vault subtree, skipping dot-directories (.obsidian, .trash, .git — the
 * G2.4 default-deny set). `root` is the absolute vault root; `sub` an optional
 * vault-relative starting directory. Returns vault-relative forward-slash paths.
 */
export function walkVault(
  root: string,
  opts: { sub?: string; extensions?: string[]; recursive?: boolean; includeFolders?: boolean } = {},
): WalkEntry[] {
  const recursive = opts.recursive ?? true;
  const exts = opts.extensions?.map((e) => e.toLowerCase());
  const absRoot = resolve(root);
  const start = opts.sub ? resolveVaultPath(absRoot, opts.sub) : absRoot;
  const out: WalkEntry[] = [];

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
      if (e.isDirectory()) {
        if (opts.includeFolders)
          out.push({ relPath: rel, type: "folder", size: 0, mtime: statSafe(abs)?.mtimeMs ?? 0 });
        if (recursive) walk(abs, rel);
      } else if (e.isFile()) {
        if (exts && !exts.some((x) => name.toLowerCase().endsWith(x))) continue;
        const st = statSafe(abs);
        out.push({ relPath: rel, type: "file", size: st?.size ?? 0, mtime: st?.mtimeMs ?? 0 });
      }
    }
  };

  const startPrefix = opts.sub ? normalizeVaultPath(opts.sub) : "";
  walk(start, startPrefix);
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

export { statSafe };
