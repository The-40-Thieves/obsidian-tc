// THE-649 — filesystem watch over each vault root, so an edit made OUTSIDE the server reaches the
// index without waiting for an explicit index_vault.
//
// Why this exists: docs/SYNC.md has always told users "the server picks them up via its filesystem
// watch" and "the server watches vaultPath and reindexes changed files". There was no watcher. Every
// sync tier in that document (headless Obsidian Sync, LiveSync, git pull, Syncthing, a bind mount)
// lands Markdown on disk with Obsidian very possibly not running on the server at all — which is
// also why this is a filesystem watch rather than the companion plugin's event stream: the bridge
// only answers while Obsidian is open, and the documented deployment does not require it to be.
//
// The eligibility rules below are NOT re-derived here: they mirror `walkVault` (vault/paths.ts),
// which is what index_vault walks. A watcher that admitted a path the full walk skips would index
// content no other code path can reach, and the two would disagree forever.
//
// There is NO self-write feedback loop to defend against, and that is a property of the indexer, not
// luck: indexing never writes a `.md` file back into the vault, and cache.db lives outside vaultPath
// by SYNC.md's contract. A note the server itself wrote is already indexed inline by the write path,
// so the watcher's echo is redundant rather than wrong — and it terminates, because the indexer's
// content_hash comparison makes the second pass a no-op re-read rather than a re-embed. Deliberately
// no second echo-suppression layer here: content_hash is where "have I already seen these bytes"
// is decided for every other caller, and a private copy in the watcher would be a second answer to
// a question that already has one.
import { lstatSync, statSync, watch } from "node:fs";
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
 * stderr. Lives here rather than inline in cli.ts, which is at its `noExcessiveLinesPerFile` cap —
 * and that cap has already been raised once (THE-610), so the file's own header asks the next
 * change to shrink it rather than raise it again.
 *
 * Structurally typed (not `ServerConfig`) for the same reason `resolveTraceDirs` is: it keeps the
 * vault module free of a dependency on the whole config schema, and keeps the tests able to call it
 * with two fields instead of a full parsed config.
 */
export function registerVaultWatch(
  vaults: readonly { id: string; path: string }[],
  cfg: { enabled: boolean; debounceMs: number },
  hooks: Pick<VaultWatchOptions, "onUpsert" | "onDelete">,
  platform: string = process.platform,
): () => void {
  if (!cfg.enabled) return () => {};
  // Not started on Windows, deliberately and conservatively.
  //
  // What was observed: Node's RECURSIVE fs.watch killed the vitest worker process outright on
  // windows-latest, in two independent CI runs, under both `persistent: false` and an explicit
  // unref() — no exception, no failing assertion, the process simply exited and that block's tests
  // vanished from the totals. The same tests pass on ubuntu, ubuntu-arm and macos.
  //
  // What was NOT established: whether a long-lived server with one watcher per vault is affected the
  // same way, rather than only a test process that creates and tears down many watchers. That is
  // exactly why this is off here instead of the claim being made either way.
  //
  // The costs are asymmetric. Off on Windows = the pre-THE-649 behaviour, index_vault on demand,
  // which is what Windows users have today — no regression. On, if the crash generalises = a server
  // that dies. Enabling it is a one-line change once someone can verify a real Windows host.
  if (platform === "win32") {
    process.stderr.write(
      "[watch] filesystem watch is not started on Windows; use index_vault to pick up external changes\n",
    );
    return () => {};
  }
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
 * and none of it has anything to do with fs.watch. Testing these through the OS watcher made
 * platform-independent rules depend on platform-specific event delivery — which is exactly how a
 * correct symlink guard came to fail on macOS for timing reasons. As a pure function of (root, rel)
 * it is deterministic on every platform.
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
      // Explicit existence check, NOT delegated to watch(). The two runtimes this ships on disagree:
      // Bun throws ENOENT synchronously, while Node returns a watcher that throws nothing, emits no
      // 'error', and silently watches nothing forever (measured on Linux 6.17, node 26 / bun 1.3).
      // Under Node alone an operator whose vault is on an unmounted volume would get NO signal that
      // it is unwatched. Checking here makes both runtimes report the same thing.
      //
      // statSync, not lstat: the vault ROOT is an operator-configured path and is legitimately a
      // symlink on plenty of setups. The lstat rule in flush() is about content DISCOVERED inside
      // the vault, which is a different trust question.
      if (!statSync(t.root).isDirectory()) {
        throw new Error(`vault root is not a directory: ${t.root}`);
      }
      // `persistent: true` (the default) plus an explicit unref(), NOT `persistent: false`. Both
      // are meant to keep the watcher from holding the event loop open, but they take different
      // paths inside libuv, and the non-persistent recursive path on Windows crashed the whole
      // vitest worker process outright — no exception, no failing assertion, just a dead worker
      // with the file's 19 tests silently missing from the totals. unref() is the documented way to
      // say "do not keep the process alive" and behaves identically on all three platforms.
      const w = watch(t.root, { recursive: true }, (_event, filename) => {
        // The event TYPE is deliberately ignored. Node reports a file creation as `rename` and Bun
        // reports the same creation as `change` (measured on Linux 6.17, node 26 / bun 1.3), so
        // branching on it would behave differently under the two runtimes this ships on. The lstat
        // in flush() is the single source of truth for what happened.
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
      w.unref?.();
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
