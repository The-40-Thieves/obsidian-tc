# Vault filesystem watcher

Extracted from inline commentary, 2026-08-21. The code carries the invariants; this note carries the history and evidence.

## Why a filesystem watch, not the companion plugin's event stream (THE-649)

`docs/SYNC.md` had told users "the server picks them up via its filesystem watch" and "the server
watches vaultPath and reindexes changed files" since before any watcher existed (#524). Every sync
tier that document describes — headless Obsidian Sync, LiveSync, `git pull`, Syncthing, a bind
mount — lands Markdown on disk with Obsidian very possibly not running on the server at all. That
is why `startVaultWatch` uses `node:fs`'s `watch` rather than the companion plugin's event bridge:
the bridge only answers while Obsidian is open, and the documented deployment does not require it
to be.

## Eligibility mirrors `walkVault`

The watch's admit/skip rule (`shouldWatchPath` in `watcher.ts`) is not re-derived independently —
it mirrors `walkVault` (`vault/paths.ts`), which is what `index_vault` walks. A watcher that admitted
a path the full walk skips would index content no other code path can reach, and the two would
disagree forever. Concretely: `.md` only, case-insensitive (walkVault lowercases before comparing,
so `NOTE.MD` is a note there and must be one here), and no dot-segment anywhere in the path
(`walkVault`'s G2.4 default-deny set — `.obsidian`, `.trash`, `.git` — which also happens to exclude
`.obsidian-tc/`, where the server writes its own session traces and prewarm cache, so the watch
cannot see its own bookkeeping).

## No self-write feedback loop

Indexing never writes a `.md` file back into the vault, and `cache.db` lives outside `vaultPath` by
`SYNC.md`'s contract, so there is no write-triggers-watch-triggers-write cycle to defend against. A
note the server itself wrote is already indexed inline by the write path; the watcher's own re-read
of that same file is redundant rather than wrong, and terminates because the indexer's
`content_hash` comparison makes the second pass a no-op re-read rather than a re-embed. There is
deliberately no second, private echo-suppression layer in the watcher: `content_hash` is where "have
I already seen these bytes" is decided for every other caller, and a private copy here would be a
second answer to a question that already has one.

## THE-657: the Windows crash, and why it was never `fs.watch` itself

Windows recursive watching was disabled for a long time on the assumption that `fs.watch({recursive:
true})` itself was unstable there. It was not. The actual crash was an **8.3 short-path** collision
reaching a native libuv assertion:

libuv prefix-compares each event's filename against the watched directory string
(`!_wcsnicmp(filename, dir, dirlen)`, `src/win/fs-event.c:72`). `os.tmpdir()` on a Windows CI runner
resolves to the 8.3 short form (`C:\Users\RUNNER~1\...`), while events arrive carrying the long
form, so the compare fails and libuv **aborts the process** — not a JS exception, a native
assertion. That is why the vitest worker vanished with no error and the affected test block simply
went missing from the totals, rather than failing loudly.

Measured on `windows-latest` via `scripts/watch-soak.mjs` — one long-lived watcher over a nested
400-file tree, with ubuntu and macos as controls on the identical harness:

| root | result |
|---|---|
| `tmpdir` (`C:\Users\RUNNER~1\...`) | DIED 276ms in, libuv assertion, exit 127 |
| `realpath` (`C:\Users\runneradmin\...`) | SURVIVED 45s, 1415 edits → 2835 events |
| `workspace` (`D:\a\...\soak-vault`) | SURVIVED 45s, 1421 edits → 2847 events |

The old open question — "does this affect a long-lived server, or only a test process churning
watchers?" — had a false premise. Watcher count and process lifetime were never the variable; path
shape was, and the test fixtures happened to live under `tmpdir`.

The fix, applied unconditionally on every platform (not just win32): resolve the watch root through
`realpathSync.native` before calling `watch()`. It is a no-op wherever short names don't exist, and a
platform-conditional fix would have left the one platform that needs it as the only one the other
three CI legs never exercise. `.native` matters specifically — the plain JS `realpathSync` does not
expand 8.3 short names, so using it would look like a fix while leaving the defect in place.

As a direct consequence, `registerVaultWatch`'s `platform` parameter was removed: it existed solely
to make the win32 skip assertable from every CI leg, and once there was no platform branch left to
assert, a parameter kept around for a deleted branch was exactly the kind of thing a future reader
would treat as load-bearing when it no longer was.

## `persistent: false` vs `unref()` — not interchangeable for a recursive watch

`persistent: false` on the `fs.watch` call is load-bearing and must not be swapped for `unref()`.
They look interchangeable — `unref()` is a real method on the returned `FSWatcher` — but are not,
specifically for a **recursive** watcher: Node backs `{recursive: true}` with a tree of internal
per-directory watchers, and calling `unref()` on the parent handle does not propagate to them. A
recursive watch created with `unref()` alone never lets the process exit, while `{recursive: true,
persistent: false}` exits immediately.

Getting this wrong does not fail a test; it hangs a process. It once cost a 20-minute install-smoke
timeout, because that CI lane runs `node dist/cli.js < /dev/null` and expects the server to reach
stdio-ready and exit — a hung recursive watch held it open for the full timeout instead. The
regression is guarded against by a source-scan assertion in `vault-watcher.test.ts`, so this cannot
be quietly reintroduced.

There was a brief detour in the code's own history: this was `unref()` for a while, because
`persistent: false` on a recursive watch was (mistakenly) blamed for killing the vitest worker on
Windows before THE-657's actual root cause (the 8.3 short-path libuv assertion, above) was found.
That detour is moot now — `registerVaultWatch` does not start a watch on win32 differently at all
any more; the realpath fix applies uniformly.

## Runtime behavior differences relied on (Node vs Bun)

Two runtime disagreements are load-bearing for how `startVaultWatch` is written, both measured
directly on Linux 6.17, Node 26 / Bun 1.3:

- **Missing vault root.** Bun's `watch()` throws `ENOENT` synchronously when the root does not
  exist; Node's returns a watcher that throws nothing, emits no `'error'`, and silently watches
  nothing forever. Without an explicit `statSync` existence check before calling `watch()`, an
  operator running under Node alone whose vault sits on an unmounted volume would get no signal that
  it is unwatched.
- **Event type for a file creation.** Node reports it as `rename`; Bun reports the identical creation
  as `change`. Branching on the event type would make the watcher behave differently depending on
  which runtime it ships under, which is why `flush()`'s `lstatSync` result — not the event type — is
  the single source of truth for what actually happened at a path.

## A correct symlink guard that failed on macOS for timing reasons

`resolveWatchedPath` was originally exercised only indirectly, through the OS watcher itself. That
coupled a platform-independent classification rule (lstat + isFile, then readNote) to
platform-specific event delivery timing — and that coupling is exactly how a symlink guard that was
logically correct came to fail on macOS: the event ordering there made the guard's precondition not
yet true at the moment the test observed it. Splitting `resolveWatchedPath` out as a pure function of
`(root, rel)`, tested directly rather than through `fs.watch`, removed the timing dependency
entirely — the guarantees now hold deterministically on every platform.

## Why `registerVaultWatch` lives in `watcher.ts`, not `cli.ts`

`cli.ts` is at its `noExcessiveLinesPerFile` lint cap, and that cap has already been raised once
(THE-610) — the file's own header asks the next change to shrink it rather than raise the cap again.
`registerVaultWatch` is the config-shaped wrapper that keeps that possible: it maps the vault list
onto watch targets structurally (not against the full `ServerConfig` type, mirroring
`resolveTraceDirs`'s own reasoning), which keeps this module free of a dependency on the whole config
schema and lets tests call it with two fields instead of a full parsed config.
