# Deployment Modes

obsidian-tc runs in five main shapes. The companion plugin and the vault always live on the **same machine as the server** — only the MCP client may be remote. Transports are configured in the JSON config (`transports.stdio` / `transports.http`), not by CLI flags; the CLI takes a config path or a vault folder.

| Aspect | STDIO local | HTTP local | HTTP remote | Docker | Standalone binary / MCPB |
|---|---|---|---|---|---|
| Process model | Subprocess of the MCP client | Background daemon | Daemon on a remote host | Container w/ bind-mount | Compiled binary / bundled host install |
| Bind address | n/a | `127.0.0.1` | non-loopback permitted | per `docker run -p` | per transport |
| Auth | `none` OK | `none` OK | **JWT required** (hard refusal in `none` on non-loopback) | per HTTP mode | per transport |
| Multi-client | 1 per process | many | many | many | 1 (STDIO) or many (HTTP) |

## STDIO local (default)

For Claude Desktop / Claude Code / Cursor. The client launches the server as a subprocess — one per client. `none` auth is typical; the trust boundary is the parent process.

```json
{
  "mcpServers": {
    "obsidian-tc": {
      "command": "npx",
      "args": ["-y", "obsidian-tc"],
      "env": { "OBSIDIAN_TC_CONFIG": "/ABSOLUTE/PATH/TO/obsidian-tc.config.json" }
    }
  }
}
```

Zero-config variant: pass a vault folder as the argument instead of a config (`"args": ["-y", "obsidian-tc", "/path/to/vault"]`).

### Several stdio clients on the same vault

"1 per process" above means every MCP client that launches obsidian-tc gets its own subprocess —
so running Claude Desktop, Claude Code, and Cursor against the **same vault config** (same
`cacheDir`) starts several independent processes that all share one `cache.db`. Each process still
elects a per-vault indexing **leader**: exactly one holds the boot/periodic reconcile and the
vault watcher's index writes; the rest are **followers** that skip both and serve reads off the
shared index. Explicit tool calls (`write_note` et al.) go through on every process regardless of
role — SQLite already serializes those writers, so gating them would add nothing.

- `server_health` reports which role a given process holds in its `leader_role` field
  (`"leader"` or `"follower"`).
- If the leader process exits — closed cleanly, crashed, or killed — a follower promotes and takes
  over within its retry window (jittered, 5-15s by default) and immediately runs its own reconcile
  to catch up anything missed in between. No client-visible action is needed; a follower already
  serves reads from the same index throughout.
- This applies within one config's `cacheDir`, not across separate vaults — two different vault
  configs never contend with each other.
- A leader that loses its lock out from under it — the held transaction gets rolled back by SQLite
  itself, or the lock file on disk gets replaced — demotes immediately rather than continuing to
  act as leader with nothing actually held; a follower promotes in its place on the next retry.
  Demotion stops this process's own writes (aborts its in-flight reconcile, drops queued
  watcher-originated index writes) before the lock actually releases, so a successor cannot start
  writing while the loser is still mid-write. A process that promotes, demotes, and is
  re-promoted runs a fresh catch-up reconcile on *every* promotion, not just the first, so nothing
  missed while it was demoted goes unindexed. Several processes cold-starting against the **same
  brand-new `cacheDir`** together (first boot, or a wiped cache) serialize their schema migrations
  through a short bootstrap barrier before election runs, so they cannot race each other's
  migration pass.

## HTTP local

Enable in config:

```json
"transports": { "http": { "enabled": true, "host": "127.0.0.1", "port": 8765 } }
```

One warm process; many local clients connect to `http://127.0.0.1:8765` (Streamable HTTP). Cold-start savings compound for agent workloads making many short calls. `none` auth is accepted on loopback only.

## HTTP remote

Server runs on a remote host (with the vault co-located); clients connect over Cloudflare Tunnel or SSH local-forward. The server **refuses to bind a non-loopback host in `none` mode** — a hardcoded interlock, not a config flag. JWT is mandatory. See **[[Security and ACL]]**.

## Docker

```bash
docker run -v /path/to/vault:/vault \
  ghcr.io/the-40-thieves/obsidian-tc:1.7.0 /vault
```

The native module is built into the image; the vault is bind-mounted. Obsidian (a GUI app with the companion + REST API plugins) runs on the **host**, not in the container, so the container must reach Obsidian's REST API port: `--network host` on Linux, or explicit port mapping on macOS/Windows.

## Standalone binary / MCPB

- `bun build --compile` produces one executable per platform (~80 MB; runtime + native statically linked, no Node/Bun install needed); binaries are built per release — see [Releases](https://github.com/The-40-Thieves/obsidian-tc/releases).
- The **MCPB bundle** (`bun run bundle` → `dist/obsidian-tc.mcpb`) installs one-click into Claude Desktop and other MCPB hosts.

## Edge case: vault on a laptop, agents on a server

**Topology A (recommended)** — server colocated with the vault. obsidian-tc + Obsidian + REST API plugin all run on the laptop; a remote agent tunnels MCP calls to the laptop's HTTP endpoint. Server↔plugin calls stay local; only the agent↔server hop crosses the network.

**Topology B** — server colocated with the agent. Every plugin-bridge call tunnels back to the laptop's Obsidian, incurring RTT per op. Available but not the default.
