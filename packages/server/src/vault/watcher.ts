// Filesystem watch over each vault root: an edit made OUTSIDE the server (any sync tier — headless
// Obsidian Sync, LiveSync, git pull, Syncthing, a bind mount) reaches the index without waiting for
// an explicit index_vault. A filesystem watch, not the companion plugin's event stream — the bridge
// only answers while Obsidian is open, and the documented deployment does not require it to be.
// THE-649. See docs/design/vault-watcher.md.
//
// Eligibility mirrors `walkVault` (vault/paths.ts) and must stay in sync with it — a watcher that
// admits a path the full walk skips would index content no other code path can reach. There is no
// self-write feedback loop and no separate echo-suppression layer: the write path indexes inline,
// and content_hash makes the watcher's redundant re-read a no-op.
import { lstatSync, realpathSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { readNote } from "./notes-io";

export interface VaultWatchTarget {
  vaultId: string;
  /** Absolute vault root. */
  root: string;
}

export interface VaultWatchOptions {
  targets: readonly VaultWatchTarget[];
  /** Called for a created/modified note. Wire to the reindex gate, NOT to the coordinator directly —
   *  the gate applies the read ACL, and a watcher must not index what a tool could not read. */
  onUpsert: (vaultId: string, relPath: string, content: string) => void;
  onDelete: (vaultId: string, relPath: string) => void;
  /** Quiet period before a burst is flushed. An editor save emits several events and a sync pass
   *  emits one per file; coalescing turns both into a single pass per path. */
  debounceMs?: number;
  onError?: (err: unknown, vaultId: string) => void;
}

/**
 * Which paths the watch acts on — the same two rules `walkVault` applies, and for the same reasons:
 *
 *   - `.md` only, matched case-INSENSITIVELY (walkVault lowercases before comparing, so `NOTE.MD`
 *     is a note there and must be one here).
 *   - no dot-segment anywhere in the path. walkVault skips any entry whose name starts with `.` at
 *     every level, which is the G2.4 default-deny set (`.obsidian`, `.trash`, `.git`). It also
 *     happens to exclude `.obsidian-tc/`, where the server writes its own session traces and
 *     prewarm cache — so the watch cannot see its own bookkeeping.
 *
 * Pure and exported so the policy is testable without touching a filesystem.
 */
export function shouldWatchPath(relPath: string): boolean {
  if (!relPath.toLowerCase().endsWith(".md")) return false;
  return !relPath.split("/").some((seg) => seg.startsWith("."));
}

/** Normalize a watcher-reported filename to a forward-slashed vault-relative path. */
export function normalizeWatchPath(filename: string): string {
  return filename.replace(/\\/g, "/");
}

/**
 * Config-shaped wrapper: maps the vault list onto watch targets and routes per-vault failures to
 * stderr. Lives here rather than inline in cli.ts, which is at its `noExcessiveLinesPerFile` cap.
 *
 * Structurally typed (not `ServerConfig`) for the same reason `resolveTraceDirs` is: it keeps the
 * vault module free of a dependency on the whole config schema, and keeps the tests able to call it
 * with two fields instead of a full parsed config. See docs/design/vault-watcher.md.
 */
export function registerVaultWatch(
  vaults: readonly { id: string; path: string }[],
  cfg: { enabled: boolean; debounceMs: number },
  hooks: Pick<VaultWatchOptions, "onUpsert" | "onDelete">,
): () => void {
  if (!cfg.enabled) return () => {};
  // Windows watch is enabled: recursive fs.watch was never the hazard it looked like. The crash was
  // a native libuv assertion from an 8.3 short watch-root path disagreeing with the long-form paths
  // event payloads carry — fixed unconditionally, on every platform, by resolving the watch root
  // through `realpathSync.native` below. THE-657. See docs/design/vault-watcher.md.
  return startVaultWatch({
    targets: vaults.map((v) => ({ vaultId: v.id, root: v.path })),
    debounceMs: cfg.debounceMs,
    onUpsert: hooks.onUpsert,
    onDelete: hooks.onDelete,
    // stderr, never stdout: the stdio MCP transport owns stdout, and a log line written there would
    // be parsed as a protocol frame.
    onError: (e, vaultId) =>
      process.stderr.write(`[watch] ${vaultId} not watched: ${(e as Error)?.message ?? e}\n`),
  });
}

/** What the filesystem says is at a watched path right now. */
export type WatchResolution =
  | { kind: "upsert"; content: string }
  | { kind: "delete" }
  | { kind: "refused"; error: unknown };

/**
 * Decide what a changed path means, and read it if it is an indexable note.
 *
 * Split out of flush() deliberately: every security-relevant guarantee of this module lives HERE,
 * independent of fs.watch, and is deterministic as a pure function of (root, rel) on every
 * platform. See docs/design/vault-watcher.md for why coupling these rules to OS watch event
 * delivery is unsafe.
 *
 * Reaching an indexable note takes BOTH guards, because they cover different aliases and neither
 * covers the other:
 *
 *   lstat + isFile()  — SYMLINKS. `walkVault` classifies from readdir Dirents, whose isFile() is
 *     false for a symlink, so index_vault silently skips them. readNote alone would NOT catch this:
 *     its open() follows the symlink and its fstat then describes the TARGET, which for an ordinary
 *     file passes every check. The walk protects the normal path, so the walk's test is what has to
 *     be reproduced.
 *   readNote()        — HARD LINKS. lstat alone would NOT catch these: a hard link IS a regular
 *     file (isFile() true, nlink 2), so a second name for an inode outside the vault reads as an
 *     ordinary note. readNote's assertRegularSingleLink fstats the OPEN fd and refuses nlink > 1 —
 *     check-and-use on one object, so not a TOCTOU either. realpath cannot dereference a hard link,
 *     so path canonicalization is no substitute.
 *
 * Calling readNote rather than readFileSync is the point: it is the exact function indexVault's own
 * note pass uses, so the watch cannot drift away from the guarantees the full index walk has.
 */
export function resolveWatchedPath(root: string, rel: string): WatchResolution {
  const abs = join(root, rel);
  try {
    // A symlink, or a directory that replaced a note. Either way there is no longer an indexable
    // note at this path, so the index must not keep one.
    if (!lstatSync(abs).isFile()) return { kind: "delete" };
  } catch {
    // Gone between the event and the flush — that IS the delete case, and it is also what a file
    // removed twice looks like. submitDelete is idempotent, so re-reporting is safe.
    return { kind: "delete" };
  }
  try {
    return { kind: "upsert", content: readNote(abs).raw };
  } catch (e) {
    // readNote REFUSED the file (hard link, not a regular file) or it vanished mid-read. Either way
    // the caller evicts; `refused` exists so a refusal can also be SURFACED, because dropping it
    // silently would be indistinguishable from an ordinary delete.
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { kind: "delete" };
    return { kind: "refused", error: e };
  }
}

/**
 * Start watching every target. Returns a stop function.
 *
 * Failure is per-vault and never fatal: a missing root, or `ENOSPC` from exhausting the inotify
 * watch limit on a large vault, reports through `onError` and leaves the other vaults watched. A
 * server that refused to boot because one vault could not be watched would be strictly worse than
 * one that indexes that vault on demand — which is the entire pre-THE-649 behaviour.
 */
export function startVaultWatch(opts: VaultWatchOptions): () => void {
  const debounceMs = opts.debounceMs ?? 500;
  const pending = new Map<string, Set<string>>(); // vaultId -> rel paths
  const rootById = new Map(opts.targets.map((t) => [t.vaultId, t.root]));
  let timer: NodeJS.Timeout | undefined;

  const flush = (): void => {
    timer = undefined;
    for (const [vaultId, paths] of pending) {
      const root = rootById.get(vaultId);
      if (root === undefined) continue;
      for (const rel of paths) {
        // All classification and every alias guard lives in resolveWatchedPath — see its docstring.
        const r = resolveWatchedPath(root, rel);
        if (r.kind === "upsert") opts.onUpsert(vaultId, rel, r.content);
        else if (r.kind === "delete") opts.onDelete(vaultId, rel);
        else {
          // Fail closed: evict rather than index, and surface the refusal.
          opts.onDelete(vaultId, rel);
          opts.onError?.(r.error, vaultId);
        }
      }
    }
    pending.clear();
  };

  const schedule = (): void => {
    if (timer !== undefined) return;
    timer = setTimeout(flush, debounceMs);
    // Unref'd, matching the scheduler's timer idiom: a pending debounce must never be the reason the
    // process stays alive.
    timer.unref?.();
  };

  const closers: Array<() => void> = [];
  for (const t of opts.targets) {
    try {
      // Explicit existence check, not delegated to watch(): Bun throws ENOENT synchronously, Node
      // returns a watcher that emits no error and silently watches nothing forever — checking here
      // makes both runtimes report the same failure. See docs/design/vault-watcher.md.
      //
      // statSync, not lstat: the vault ROOT is an operator-configured path and is legitimately a
      // symlink on plenty of setups. The lstat rule in flush() is about content DISCOVERED inside
      // the vault, which is a different trust question.
      if (!statSync(t.root).isDirectory()) {
        throw new Error(`vault root is not a directory: ${t.root}`);
      }
      // `persistent: false` is LOAD-BEARING — do not swap for `unref()`. They are not
      // interchangeable for a RECURSIVE watcher: Node backs `{recursive: true}` with a tree of
      // internal per-directory watchers, and unref'ing the parent handle does not propagate to
      // them, so the process never exits. Getting this wrong does not fail a test; it hangs the
      // process. Guarded by a source-scan assertion in vault-watcher.test.ts. See
      // docs/design/vault-watcher.md.
      //
      // Watch the REALPATH, not the configured string, unconditionally on every platform (a no-op
      // where 8.3 short names don't exist): a short-path watch root can disagree with the long-form
      // names event payloads carry and crash the process. THE-657. `.native` matters — the plain JS
      // realpath does not expand 8.3 short names.
      const watchRoot = realpathSync.native(t.root);
      const w = watch(watchRoot, { recursive: true, persistent: false }, (_event, filename) => {
        // Event TYPE is deliberately ignored: Node reports a file creation as `rename`, Bun reports
        // the same creation as `change` — branching on it would behave differently per runtime. The
        // lstat in flush() is the single source of truth for what happened.
        if (filename === null) return; // platform gave us no name — nothing actionable
        const rel = normalizeWatchPath(String(filename));
        if (!shouldWatchPath(rel)) return;
        let set = pending.get(t.vaultId);
        if (set === undefined) {
          set = new Set();
          pending.set(t.vaultId, set);
        }
        set.add(rel);
        schedule();
      });
      w.on("error", (e) => opts.onError?.(e, t.vaultId));
      closers.push(() => w.close());
    } catch (e) {
      opts.onError?.(e, t.vaultId);
    }
  }

  return () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    for (const c of closers) {
      try {
        c();
      } catch {
        /* already closed */
      }
    }
  };
}
