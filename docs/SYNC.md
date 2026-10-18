# Vault Sync

`obsidian-tc` is sync-agnostic. Its only contract is a directory of Markdown: point the
server at a vault path and it indexes what it finds. How files arrive in that directory is
up to you. The methods below are independent tools that write `.md` files into the vault
directory; none of them are part of the server.

## The contract

- The server reads a single `vaultPath`. Anything that lands Markdown there works: Obsidian
  Sync, self-hosted LiveSync, git, Syncthing, a bind mount, or files already on disk.
- The server's own databases live **outside** `vaultPath`. `cache.db` and the experiential
  store are large, frequently rewritten binaries. Inside a synced folder, every sync tool
  tries to replicate them and generates conflicts. Keep them in a sibling data directory.
  This is the default; do not override it into the vault.
- After a sync pass writes files, the server picks them up via its filesystem watch. Tools
  that sync in discrete passes can also call the reindex entrypoint explicitly (see
  [Reindex](#reindex)).

## Choosing a tier

| Tier | Tool | Sync path | Cost | Best for |
| ---- | ---- | --------- | ---- | -------- |
| 1 | Obsidian Sync (headless) | Obsidian's servers, zero-knowledge E2E | Paid Sync subscription | Already on Sync; least setup |
| 2 | Self-hosted LiveSync | Your own CouchDB | Self-hosted | Whole path on infrastructure you own |
| 3 | git (server-run `-git` image, or manual) / Syncthing / bind mount | Your own or peer-to-peer | Free | No subscription, no CouchDB |

All three end the same way: Markdown lands in `vaultPath`, the server indexes it.

## Tier 1: Obsidian Sync (headless)

Official headless client, no desktop GUI. Requires Node.js 22+ and an Obsidian Sync
subscription. Install per <https://github.com/obsidianmd/obsidian-headless>.

```sh
ob login
cd /path/to/vault
ob sync-setup --vault "My Vault"
ob sync --continuous   # daemon: watches and syncs both directions
```

Point the server at `/path/to/vault`. Edits on any device land here within seconds, with
Obsidian's own conflict resolution. The sync path transits Obsidian's servers (end-to-end
encrypted, zero-knowledge). For a fully self-owned path, use Tier 2.

## Tier 2: Self-hosted LiveSync (sovereign default)

A CouchDB hub you run, plus a headless LiveSync client on the server. Nothing leaves
machines you control. CouchDB runs well on ARM64.

1. Run CouchDB (Docker) on a host your devices and the server can reach.
2. In Obsidian on your devices, install the Self-hosted LiveSync plugin and point it at
   that CouchDB.
3. On the server, run a headless LiveSync client that writes the vault into `vaultPath`.

Keep the server's databases outside the LiveSync vault directory.

## Tier 3: plain (git / Syncthing / bind mount)

No subscription, no CouchDB.

- **git** — the `-git` image keeps the vault in step with a Git remote on its own, see
  [git, kept in sync by the server](#git-kept-in-sync-by-the-server-the--git-image). Without it,
  commit from your editing machine, pull on the server (cron or webhook), then call the reindex
  entrypoint in a post-merge step. Versioned and auditable; not real-time.
- **Syncthing** — run the daemon on both ends and share the vault folder. Continuous,
  headless, peer-to-peer. Exclude the server's database directory from the shared folder.
- **bind mount / network share** — if the vault already lives on the host or a mount, point
  `vaultPath` at it directly. No sync tool needed.

### git, kept in sync by the server (the `-git` image)

The `-git` image runs `obsidian-tc git-sync --supervise`. It starts the server as a child process
and keeps `vaultPath` in step with a Git remote beside it. The sidecar is POSIX only (Linux and
macOS) and refuses to run on Windows. Container first: the `-git` image is the supported way to run it.

The `-git` tags are first published with the next release. Until then, build the image from a
checkout with `docker build --target git -t obsidian-tc:git .`. The Docker deployment page covers
the image and its run command.

**What it does**

- **Boot.** Clones the remote into an empty vault directory, or verifies an existing clone whose
  `origin` matches the configured URL and pulls once before the server starts. It refuses, exits
  non-zero and names the directory when the directory holds files that are not a clone of that
  remote. It never deletes or overwrites a file it did not write.
- **Pull** on `OBSIDIAN_TC_VAULT_GIT_PULL_INTERVAL` (default 30 seconds, minimum 10), and at once
  when a webhook arrives. A dirty tree is committed first, then the remote is fetched and local
  commits are rebased onto it.
- **Commit** local changes in batches. A batch is committed after 10 seconds without further
  changes, or 60 seconds after the tree first went dirty, whichever comes first. Each batch is one
  commit, `obsidian-tc: update N notes`, listing up to 20 changed paths.
- **Push** after the rebase, when the local branch is ahead of the remote.
- **Mirror.** `OBSIDIAN_TC_VAULT_GIT_PUSH=off` makes the vault a read-only mirror: no commits and no
  push, and the pull only fast-forwards. A dirty tree that blocks a pull is reported, not discarded.
  Pair it with `acl.readOnly`.

The server's filesystem watch picks up the sidecar's writes, so no reindex call is needed.

**Conflicts.** A rebase conflict, or a push still rejected after three rounds of re-fetch and
re-rebase, is never merged or discarded. The sidecar:

1. aborts the rebase;
2. pushes the local commits to a rescue branch, `obsidian-tc/conflict/<UTC timestamp>`;
3. resets the vault to the upstream branch;
4. records the conflict in `status.json`.

Merge the rescue branch from a device to resolve it. Agent writes have their own guard: a write
based on a stale read is refused by the `prev_hash` compare-and-swap, not merged blind.

One race remains, and the design accepts it. The sidecar cannot lock the server's writes, so an MCP
write that lands between the pre-fetch commit and the rebase checkout can be overwritten, but only
when upstream changed the same file in that pull. Committing right before the fetch keeps that
window small.

**Credentials.** Give the sidecar one of two secrets:

- `OBSIDIAN_TC_VAULT_GIT_SSH_KEY`, the private key contents, for a `git@host:org/repo.git` or
  `ssh://` URL. The server pushes, so use a deploy key with write access. Optionally pin the host
  with `OBSIDIAN_TC_VAULT_GIT_KNOWN_HOSTS`; without it the first host key seen is trusted.
- `OBSIDIAN_TC_VAULT_GIT_TOKEN`, for an `https://` URL.

The key is written with mode 0600 under the state directory and used through `GIT_SSH_COMMAND` with
`IdentitiesOnly=yes`. The token reaches Git through `GIT_ASKPASS`. Neither appears in argv, in
`.git/config`, in the remote URL or in logs, and a URL that carries a password or token is refused.

**State.** The state lives in `<OBSIDIAN_TC_CACHE_DIR>/git-sync/`, outside the vault:

- `status.json` holds `lastPullAt`, `lastPushAt`, `head`, `lastError` and `conflicts`.
- One line per sync event goes to stderr. It never contains a secret.

**The other half is obsidian-git.** obsidian-git keeps the vault in step with the same remote on
each device, and the sidecar is the server's side of that loop.

#### Webhook (optional)

Set `OBSIDIAN_TC_VAULT_GIT_WEBHOOK_SECRET` to mount `POST /hooks/vault-sync` behind the same Host
check as `/mcp`. The secret must be at least 32 characters, or the server refuses to start.

Configure the forge to sign each request. The route accepts GitHub or Gitea/Forgejo
`X-Hub-Signature-256` (HMAC-SHA256 of the raw body) and GitLab `X-Gitlab-Token` (the secret itself).
A valid request gets `202` and triggers an immediate pull. A bad signature gets `401`, with no
detail either way. The body is capped at 1 MB and never parsed. The route cannot run git, choose a
ref or pass input to the sidecar, so a forged trigger can cause at most an early pull.

## Reindex

The server watches `vaultPath` recursively and reindexes notes that change underneath it,
whoever wrote them. Events are coalesced over a short quiet period (`watch.debounceMs`,
default 500 ms), so one editor save or one sync pass costs a single reindex per file rather
than one per event.

The watch admits exactly what `index_vault` walks and nothing more: `.md` files only, and no
directory whose name begins with a dot (`.obsidian`, `.trash`, `.git`). Neither can be used to
pull content in from outside `vaultPath` — a **symlink** is skipped by both, and a **hard
link** is refused by both (a file with more than one name is not read, because a hard link is a
second name for an inode that may live anywhere on the same filesystem and cannot be resolved
away by `realpath`). A refused file is evicted from the index rather than indexed, and the
refusal is written to stderr.

Changes are read-ACL-gated the same way a `write_note` is; a path your ACL hides from reads is
evicted from the index rather than added to it.

Set `watch.enabled: false` to turn it off — worth doing for a vault on a filesystem with no
usable change notification (some network mounts) or to cap inotify usage on a very large
vault. If a vault root does not exist at startup, that vault is not watched and the reason is
written to stderr; the other vaults are unaffected.

> **Active on Windows since v1.20.0.** It was previously disabled there because Node's recursive
> `fs.watch` terminated the test process outright in CI. That turned out not to be recursive
> `fs.watch` at all: libuv prefix-compares each event's filename against the watched directory and
> aborts the process when they disagree, and `os.tmpdir()` on a Windows CI runner is an 8.3 short
> path (`C:\Users\RUNNER~1\...`) while the events carry the long form. The watch root is now
> resolved with `realpathSync.native` before watching, on every platform, and Windows soaks
> cleanly.

`index_vault` remains available and is still the right call after a pass-based sync (a git
pull, a completed `ob sync`) when you want the whole tree reconciled in one pass rather than
file by file — and it is the only mechanism when the watch is off.

## What never syncs

Regardless of tier, never place these inside the synced vault directory:

- `cache.db` (the index)
- the experiential store (the membrane)

These are server-local state. Syncing them corrupts both the sync set and the index.
