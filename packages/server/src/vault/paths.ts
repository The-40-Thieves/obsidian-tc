// Path safety + filesystem helpers shared by every path-based tool.
// All vault access funnels through resolveVaultPath: the only place that turns a
// caller-supplied vault-relative path into an absolute filesystem path, with a
// traversal/containment guard. Nothing else should join paths against the root.
import { createHash } from "node:crypto";
import { type Dirent, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { recordPathUse } from "./acl-audit";

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
  if (relPath.startsWith("/") || relPath.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(relPath))
    throw err.pathInvalid("absolute paths are not allowed", { path: relPath });
  const parts = relPath.split(/[\\/]+/);
  if (parts.some((p) => p === ".."))
    throw err.pathInvalid("path traversal is not allowed", { path: relPath });
  if (parts.some((p) => /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i.test(p)))
    throw err.pathInvalid("Windows reserved names are not allowed", { path: relPath });
  return parts.filter((p) => p !== "" && p !== ".").join("/");
}

/** realpathSync that returns null when the path can't be resolved (e.g. doesn't exist yet). */
function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Canonicalize `abs` through symlinks for the deepest segment that exists on disk:
 * realpath(abs) when it exists, otherwise realpath of its nearest existing ancestor
 * rejoined with the not-yet-created tail. Lets a to-be-created path be containment-checked
 * without requiring it to exist. The vault root always exists, so the walk terminates.
 */
function realpathDeepest(abs: string): string {
  const tail: string[] = [];
  let dir = abs;
  for (let depth = 0; depth < 4096; depth++) {
    const real = realpathOrNull(dir);
    if (real !== null) return tail.length === 0 ? real : join(real, ...tail);
    const parent = dirname(dir);
    if (parent === dir) break;
    tail.unshift(basename(dir));
    dir = parent;
  }
  return abs;
}

/**
 * Resolve a vault-relative path to an absolute filesystem path, guaranteeing the result
 * stays within the vault root. Two layers: a byte-level traversal guard (absolute / `..`
 * rejection) and a real-path containment check that canonicalizes both the root and the
 * deepest existing segment of the target through symlinks — so an in-vault symlink (or a
 * symlinked ancestor) pointing outside the root is rejected, not just lexical `..`.
 * Throws path_invalid otherwise.
 */
export interface ResolvedVaultPath {
  /** Absolute filesystem path (lexical resolve; symlinks NOT collapsed) for fs operations. */
  abs: string;
  /** Vault-relative form of the REAL (symlink-resolved) target, forward-slashed, for ACL checks. */
  aclRel: string;
}

/**
 * resolveVaultPath + the ACL-relative path. `aclRel` is the vault-relative form of the REAL
 * (symlink-resolved) target: the folder ACL must gate THIS, not the lexical request path, or an
 * in-vault symlink under an allowed folder pointing at a denied folder would pass the ACL
 * (THE-269). For a non-symlink path aclRel equals the lexical rel, so callers that thread the
 * root into enforcePathAcl see no behavior change except on symlinked paths.
 */
export function resolveVaultPathChecked(vaultRoot: string, relPath: string): ResolvedVaultPath {
  const clean = normalizeVaultPath(relPath);
  const root = resolve(vaultRoot);
  const abs = clean === "" ? root : resolve(root, clean);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw err.pathInvalid("path escapes the vault root", { path: relPath });
  // The real-path containment guarantee hinges on canonicalizing the root. If the
  // vault root can't be resolved (deleted / transiently unavailable), fail closed
  // instead of falling back to the raw root, which would silently degrade this
  // check to the byte-level guard above. Also keeps realpathDeepest's walk
  // terminating on a resolvable ancestor rather than returning an un-canonical abs.
  const realRoot = realpathOrNull(root);
  if (realRoot === null)
    throw err.vaultNotFound("vault root could not be resolved", { path: relPath });
  const realRel = relative(realRoot, realpathDeepest(abs));
  if (realRel.startsWith("..") || isAbsolute(realRel))
    throw err.pathInvalid("path escapes the vault root", { path: relPath });
  return { abs, aclRel: realRel.split(sep).join("/") };
}

export function resolveVaultPath(vaultRoot: string, relPath: string): string {
  const resolved = resolveVaultPathChecked(vaultRoot, relPath);
  // THE-414 / #280: report the fs-op path to the (default-off) ACL audit so a dev/test run can
  // catch a pathAcl extractor that does not mirror the handler's real path usage.
  recordPathUse(resolved.aclRel);
  return resolved.abs;
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

/**
 * THE-490: streaming counterpart to walkVault. Yields one WalkEntry at a time via an async
 * generator instead of accumulating the whole subtree into an array-then-sort, so a caller that
 * processes and discards each entry keeps peak memory bounded by the SINGLE largest directory in
 * the tree rather than by the total file count, and can start processing the first entry before
 * the rest of the tree has even been read.
 *
 * Entries are sorted WITHIN one directory (by name) for run-to-run determinism, but there is no
 * whole-tree sort — this is NOT a drop-in replacement for walkVault's sorted-array contract, and
 * is deliberately additive: walkVault's return type, sort order, and every one of its other
 * callers are untouched. A per-directory sort can disagree with walkVault's whole-relPath sort
 * whenever a directory name is a prefix of a sibling file name (e.g. folder "b" vs file "b.md" —
 * see test/vault-primitives.test.ts); only use this where that reordering is known not to matter
 * (indexVault's opt-in `walk.streaming`, verified order-independent for index OUTPUT — see
 * test/index-stream-walk-equivalence.test.ts).
 */
export async function* walkVaultStream(
  root: string,
  opts: { sub?: string; extensions?: string[]; recursive?: boolean; includeFolders?: boolean } = {},
): AsyncGenerator<WalkEntry> {
  const recursive = opts.recursive ?? true;
  const exts = opts.extensions?.map((e) => e.toLowerCase());
  const absRoot = resolve(root);
  const start = opts.sub ? resolveVaultPath(absRoot, opts.sub) : absRoot;

  async function* walk(dir: string, prefix: string): AsyncGenerator<WalkEntry> {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Bounded-window sort: deterministic order WITHIN this one directory's children only — no
    // whole-tree accumulation or sort. The caller sees each entry as soon as THIS directory (not
    // the whole subtree) has been read.
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    for (const e of sorted) {
      const name = e.name;
      if (name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${name}` : name;
      const abs = join(dir, name);
      if (e.isDirectory()) {
        if (opts.includeFolders)
          yield { relPath: rel, type: "folder", size: 0, mtime: statSafe(abs)?.mtimeMs ?? 0 };
        if (recursive) {
          yield* walk(abs, rel);
          // Cooperative yield point: gives a caller's own pending async work (e.g. an embed-batch
          // flush interleaved with the walk in indexVault's streaming path) a chance to run
          // instead of this generator monopolizing the microtask queue across a huge subtree.
          await Promise.resolve();
        }
      } else if (e.isFile()) {
        if (exts && !exts.some((x) => name.toLowerCase().endsWith(x))) continue;
        const st = statSafe(abs);
        yield { relPath: rel, type: "file", size: st?.size ?? 0, mtime: st?.mtimeMs ?? 0 };
      }
    }
  }

  const startPrefix = opts.sub ? normalizeVaultPath(opts.sub) : "";
  yield* walk(start, startPrefix);
}

export { statSafe };
