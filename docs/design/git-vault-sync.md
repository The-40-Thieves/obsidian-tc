# Git-backed vault sync

Design note, 2026-10-17. On a cloud host (Railway, Render, Fly, a VPS) no Obsidian is running, so a
fresh deploy starts with an empty vault. This note covers how such a host keeps `/data/vault` in step
with the user's vault repository, which obsidian-git keeps in sync on their devices.

## Decisions

### A sidecar process, not server code

`docs/SYNC.md` states the contract: the server reads a directory of Markdown and is sync-agnostic.
Git sync keeps that contract. It is a separate process, `obsidian-tc git-sync`, which ships in the
same package but never imports the server runtime. It talks to the server only through the
filesystem: the vault directory, which the vault watcher already treats as external edits, and one
trigger file (see the webhook section below).

The sidecar is POSIX only (Linux, macOS) and refuses to run on Windows. It depends on POSIX file
modes for credential files, `/bin/sh` for Git's SSH and askpass commands, and SIGTERM shutdown
semantics. Its deployment target is the `-git` container image described below.

It runs in the same container because single-container hosts give a volume to exactly one service.
Railway, Render and Fly all work this way. A second service could not see the vault.

The `git` and `openssh-client` packages add 112 MB to bare `oven/bun:1.4.2-slim` (git 2.47.3,
OpenSSH 10.0p2; git pulls in perl), and 165 MB (157 MiB) to the built runtime image, measured with
`docker image inspect` on the first `-git` build (2026-10-18). So they ship only in a
`:<version>-git` image variant, whose entrypoint runs `git-sync --supervise`. That launcher:
1. clones or verifies the vault;
2. finishes one pull;
3. starts the server as a child;
4. exits when either process exits, so the platform restarts the container.

The default image is unchanged.

The two rejected options:
- **In-server, system git:** every image would grow by about 165 MB, and the SYNC.md contract would be
  reversed.
- **In-server, isomorphic-git:** HTTPS only (no SSH deploy keys) and no rebase. It also reverses the
  contract.

### Configuration: environment only

A single vault, matching the existing `OBSIDIAN_TC_VAULT_PATH` overlay:

| Variable | Meaning | Default |
| --- | --- | --- |
| `OBSIDIAN_TC_VAULT_GIT_URL` | `git@host:org/repo.git` or `https://host/org/repo.git` | required |
| `OBSIDIAN_TC_VAULT_GIT_BRANCH` | branch to track | the remote's HEAD |
| `OBSIDIAN_TC_VAULT_GIT_SSH_KEY` | private key contents (SSH URLs); needs write access for push | none |
| `OBSIDIAN_TC_VAULT_GIT_KNOWN_HOSTS` | `known_hosts` lines to pin the host key | trust on first use |
| `OBSIDIAN_TC_VAULT_GIT_TOKEN` | token for HTTPS URLs (fine-grained PAT, deploy token) | none |
| `OBSIDIAN_TC_VAULT_GIT_AUTHOR` | `Name <email>` for commits made here | `obsidian-tc <obsidian-tc@localhost>` |
| `OBSIDIAN_TC_VAULT_GIT_PULL_INTERVAL` | seconds between pulls, minimum 10 | `30` |
| `OBSIDIAN_TC_VAULT_GIT_PUSH` | `batched`, or `off` for a read-only mirror | `batched` |
| `OBSIDIAN_TC_VAULT_GIT_WEBHOOK_SECRET` | enables the webhook route | none |

The vault directory comes from `OBSIDIAN_TC_VAULT_PATH`, and sync state lives under
`<OBSIDIAN_TC_CACHE_DIR>/git-sync/`, outside the vault, as SYNC.md requires.

Secrets never appear in argv, in `.git/config`, in the remote URL or in logs:
- **SSH key:** written with mode 0600 under the state directory and used through `GIT_SSH_COMMAND`
  with `IdentitiesOnly=yes`.
- **Host keys:** checked against a `UserKnownHostsFile` in the state directory, with
  `StrictHostKeyChecking=yes` when `KNOWN_HOSTS` is given and `accept-new` otherwise.
- **HTTPS token:** supplied through `GIT_ASKPASS`, with the token kept in the child's environment.

### Boot

| Vault directory | Action |
| --- | --- |
| Empty, or containing only directories with no files | Clone into it. |
| A clone whose `origin` matches the URL | Pull. |
| Anything else (files, no `.git`, or another remote) | Refuse, exit non-zero, and name the directory. |

The sidecar never deletes or overwrites files it did not write.

### The sync loop

One loop per vault, with a single operation in flight:

1. **Commit local changes**, batched. On each tick (2 s), `git status --porcelain` checks for
   changes. When the tree is dirty, the sidecar waits for 10 s without further changes, or 60 s
   since it first went dirty, whichever comes first. Then it makes one commit with `git add -A`,
   which respects the repository's own `.gitignore`. The commit message is
   `obsidian-tc: update N notes` plus the paths (capped).
2. **Pull:** on the interval or a trigger. Before fetching, any dirty tree is committed at once
   (step 1 without the quiet window). Then `git fetch` runs, and local commits are rebased onto the
   upstream branch.
3. **Push** when ahead of upstream.

With `PUSH=off`, steps 1 and 3 never run. Pull is fast-forward only, and a dirty tree that blocks it
is reported, not discarded. Pair `PUSH=off` with `acl.readOnly`.

### Conflicts: refuse, keep everything, report

A rebase conflict, or a push rejected three times in a row after re-fetching and re-rebasing, is
handled the same way:
1. Abort the rebase.
2. Push the local commits to `obsidian-tc/conflict/<UTC timestamp>`.
3. Reset to the upstream branch.
4. Record the conflict.

Nothing is lost: the user merges that branch from a device. The server-side tree always equals
upstream after a conflict, so the next pull is clean. Agents keep the existing guard: `prev_hash` CAS
on writes means a write based on a stale read is refused, not merged blind.

There is a residual race, because the sidecar cannot lock the server's writes. An MCP write landing
in the milliseconds between the forced pre-fetch commit and the rebase checkout can be overwritten,
but only if upstream changed the same file in that pull. The window is kept small by committing
right before fetching. Closing it fully needs server cooperation, which this design deliberately
does not take.

### State and observability

`<cache>/git-sync/status.json` holds `lastPullAt`, `lastPushAt`, `head`, `lastError` and
`conflicts[]`. One log line goes to stderr per sync event, never with secrets. Surfacing this in
`server_health` is a follow-up.

### Webhook

The webhook triggers a pull, and it needs the one public port, which belongs to the server. So it is
the one server change:
- **Route:** `POST /hooks/vault-sync`, mounted only when `OBSIDIAN_TC_VAULT_GIT_WEBHOOK_SECRET` is
  set, behind the same Host guard as `/mcp`.
- **Accepted signatures:**
  - GitHub and Gitea/Forgejo `X-Hub-Signature-256` (`sha256=` HMAC-SHA256 of the raw body);
  - GitLab `X-Gitlab-Token` (the secret itself).

  Both are compared with `timingSafeEqual`.
- **Body:** capped at 1 MB and never parsed or used.
- **Response:** 202, or 401 for a bad signature, with no detail either way.
- **Effect:** touching `<cache>/git-sync/trigger`. The sidecar polls that file's mtime every second
  and starts a pull (coalesced: at most one pending).

The route cannot run git, choose a ref or pass any input to the sidecar. A forged trigger can only
cause an early pull.

## Alternatives, documented rather than built

- **rclone bisync to S3 or R2:** for users without git. No history, conflicts become `.conflict`
  copies, and it needs the rclone binary.
- **The TC Bridge from a running desktop:** the server reads and writes through Obsidian on a device
  (the Deployment Modes "Topology B"). It needs that device online.
- **Obsidian Sync headless and Self-hosted LiveSync:** `docs/SYNC.md` tiers 1 and 2. They run beside
  the server the same way this sidecar does.

## Build order (one pull request each)

1. This note, plus `git-sync` itself (clone or refuse, the loop, batched commits, the conflict
   branch, push retry, the status file, secret handling), tested against a local bare repository
   with real git.
2. The `-git` image variant: a Dockerfile target, `--supervise`, publish wiring, and a ci-docker
   smoke that drives `read_note` and `write_note` over `/mcp` against a mounted bare repository
   in both directions.
3. The webhook route, with a cross-vendor security review.
4. Docs: SYNC.md tier 3, the Docker and Railway pages, and a `-git` compose example.

## Acceptance

- A commit pushed from a laptop clone is visible through `read_note` within one pull interval.
- A `write_note` through MCP appears as a commit on the laptop after its next pull.
- Both directions are covered by a recorded test: the bare-repository tests in step 1 and the image
  smoke in step 2.
