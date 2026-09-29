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
- SQLite serializes concurrent commits, but ordering alone doesn't stop a *stale* one from
  landing: a write planned before a fresher commit (or a deindex) could previously still apply if
  its own commit happened to land second. Every write now re-checks a per-`(vault, path)` fence
  generation inside its own commit transaction and is dropped, not applied, if a fresher commit or
  delete already moved that generation past its own — this is enforced per path across every
  process sharing the `cacheDir`, leader and followers alike, not just within one process's own
  writes.

The leader lock above removes the double-*indexing* cost of several stdio processes on one vault,
but each process still pays its own **model-load** cost — every subprocess loads its own copy of
the embedding model and ONNX runtime. An alternative that removes that too: run **[one shared HTTP
server for several clients](#run-one-shared-server-for-several-clients)**, below.

## HTTP local

Enable in config:

```json
"transports": { "http": { "enabled": true, "host": "127.0.0.1", "port": 8765 } }
```

One warm process; many local clients connect to `http://127.0.0.1:8765` (Streamable HTTP). Cold-start savings compound for agent workloads making many short calls. `none` auth is accepted on loopback only.

### Run one shared server for several clients

**When to use it:** two or more MCP clients (Claude Desktop, Claude Code, Cursor, VS Code, Zed,
opencode, Windsurf/Devin Desktop, Gemini CLI, ChatGPT, Devin, Cline, Roo Code, Continue, Goose,
Amazon Q Developer CLI, Kiro, JetBrains, Warp, Augment, …) pointed at the *same vault*. The
[several-stdio-clients](#several-stdio-clients-on-the-same-vault) mode above
already collapses several processes onto one `cache.db` and one indexing leader, but each process
still loads its own copy of the embedding model and ONNX runtime — see the install-footprint and
per-model RAM figures in the [embeddings guide](https://github.com/The-40-Thieves/obsidian-tc/blob/main/docs/src/content/docs/configuration/embeddings.md#known-gaps),
and the whole-process peak-RSS numbers in the [performance
benchmarks](https://github.com/The-40-Thieves/obsidian-tc/blob/main/docs/src/content/docs/observability/performance-benchmarks.md).
Running one HTTP server instead of N stdio processes is a zero-extra-code trade: this transport
already exists, so the only work is pointing every client at it instead of letting each one spawn
its own subprocess.

#### 1. Start the server

Enable HTTP, bind it to loopback, and require JWT auth since several clients now share one server:

```json
{
  "vaults": [{ "id": "primary", "path": "/home/user/vaults/primary" }],
  "cacheDir": "/home/user/.cache/obsidian-tc",
  "transports": { "http": { "enabled": true, "host": "127.0.0.1", "port": 8765 } },
  "auth": { "mode": "jwt", "jwtSecret": "<32+ char secret, or set OBSIDIAN_TC_JWT_SECRET instead>" }
}
```

`auth.mode: none` also works on a loopback bind for a single trusted operator (see **HTTP local**
above), but with several *different* clients sharing one server, `jwt` with a token per client
(next step) keeps a leaked client config from impersonating another, and puts scope/ACL
enforcement (see **[[Security and ACL]]**) on a per-caller basis instead of blanket. Start it like
any other config:

```sh
obsidian-tc ./config.json
```

#### 2. Authenticate — mint a token per client

Mint a bearer token with the CLI's `token mint` command, once per client identity:

```sh
obsidian-tc token mint --sub claude-code --scopes "read:vault,write:vault/**" ./config.json
```

- `--sub` is the caller identity carried on the token — use a distinct value per client so
  `server_health` and audit logs can tell them apart.
- `--scopes` narrows what that token can do (op-on-path scopes; see **[[Security and ACL]]**);
  omit it for the default `["*"]` (everything).
- `--vault` binds the token to one vault on a multi-vault server.
- `--ttl` defaults to `auth.tokenTtlSeconds` (86400s / 24h by default); the command refuses a
  `--ttl` longer than that cap outright, since the server rejects a token on **age**, not `exp`,
  once past it.
- Repeat with a different `--sub` for each additional client — nothing here is shared between
  clients except the one running server.

Full flag reference: `obsidian-tc token mint --help`, or
[`token-mint.ts`](https://github.com/The-40-Thieves/obsidian-tc/blob/main/packages/server/src/cli/commands/token-mint.ts).

#### 3. Point every client at it

**Claude Code** — native HTTP MCP support:

```sh
claude mcp add --transport http obsidian-tc http://127.0.0.1:8765/mcp \
  --header "Authorization: Bearer <token from step 2>"
```

**Cursor** (`~/.cursor/mcp.json`) — the `url` form:

```json
{
  "mcpServers": {
    "obsidian-tc": {
      "url": "http://127.0.0.1:8765/mcp",
      "headers": { "Authorization": "Bearer <token from step 2>" }
    }
  }
}
```

**Claude Desktop** has no native Streamable HTTP client as of this writing — bridge it with
[`mcp-remote`](https://github.com/geelen/mcp-remote), a third-party stdio↔HTTP proxy this project
does not maintain, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "obsidian-tc": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "http://127.0.0.1:8765/mcp",
        "--header", "Authorization:Bearer <token from step 2>"
      ]
    }
  }
}
```

`mcp-remote`'s default transport strategy tries Streamable HTTP first and falls back to SSE, which
matches this server's `/mcp` endpoint with no `--transport` flag needed. Confirm the current
flags against `mcp-remote`'s own README before relying on this verbatim — it is a moving target
this project does not control.

**ChatGPT** (Developer Mode custom connectors) speaks only to a **remote, public HTTPS** MCP
server — there is no local/stdio option at all (OpenAI's current Developer Mode / Apps SDK docs).
Put the HTTP server above behind a public HTTPS front (a tunnel, or a real deployment) with `jwt`
auth, then add that URL as a Developer Mode connector — the same `token mint` step (2) applies,
scoped to that connector's own `--sub`.

#### Security notes

- **Bind to `127.0.0.1`.** Every client above runs on the same machine as the server; nothing
  here needs a routable host. A non-loopback bind is refused outright while `auth.mode: none`
  (the fail-closed interlock in **[[Security and ACL]]**), and even under `jwt` a routable bind is
  a materially different exposure than this section covers — see **HTTP remote** below for that.
- **One token per client**, not one shared token, so a leaked client config only leaks that
  client's own scope, and calls stay attributable per `sub`.
- **Scopes and the folder ACL still apply per call**, same as any other transport — narrowing
  `--scopes` at mint time is defense-in-depth on top of, not instead of, the vault's
  `acl.readPaths` / `writePaths` / `deletePaths` config.
- Don't expose this past loopback without the full hardening documented in
  **[[Security and ACL]]** (non-loopback bind, mandatory JWT, JWKS/algorithm allowlist,
  Origin/Host validation) — the config above is scoped to same-machine clients only.

#### Trade-offs vs. one process per client

| | several stdio processes | one shared HTTP server |
|---|---|---|
| Embedding model loads | one per client | one, total |
| Index writer | one leader among followers (elected, see above) | the one process — no election needed |
| Keeping it running | client owns the process lifecycle | **you** do — see the user service below |
| Client version skew | each client can pin its own obsidian-tc version | every client talks to whatever version is running |
| Auth | `none` typical (trust boundary = parent process) | `jwt` recommended (trust boundary = the token) |

#### Keep it running: a user service

The server has to be up before a client tries to connect, and stay up across client restarts.
Minimal starting points — adjust the binary path (`which obsidian-tc`, or the npx wrapper),
working directory, and logging for your install:

**systemd** (`~/.config/systemd/user/obsidian-tc.service`):

```ini
[Unit]
Description=obsidian-tc shared MCP server

[Service]
ExecStart=/usr/bin/env obsidian-tc /ABSOLUTE/PATH/TO/config.json
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now obsidian-tc.service
```

**launchd** (macOS, `~/Library/LaunchAgents/io.the40thieves.obsidian-tc.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>io.the40thieves.obsidian-tc</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/obsidian-tc</string>
    <string>/ABSOLUTE/PATH/TO/config.json</string>
  </array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
```

```sh
launchctl load ~/Library/LaunchAgents/io.the40thieves.obsidian-tc.plist
```

## HTTP remote

Server runs on a remote host (with the vault co-located); clients connect over Cloudflare Tunnel or SSH local-forward. The server **refuses to bind a non-loopback host in `none` mode** — a hardcoded interlock, not a config flag. JWT is mandatory. See **[[Security and ACL]]**.

## Docker

```bash
docker run -v /path/to/vault:/vault \
  ghcr.io/the-40-thieves/obsidian-tc:1.7.0 /vault
```

The native module is built into the image; the vault is bind-mounted. Obsidian (a GUI app with the companion + REST API plugins) runs on the **host**, not in the container, so the container must reach Obsidian's REST API port: `--network host` on Linux, or explicit port mapping on macOS/Windows.

A container run detached (`docker run -d`, or any compose service without `stdin_open: true`) has stdin backed by `/dev/null`. If `transports.http.enabled` is also true, that stdin EOF closes only the stdio transport — the HTTP listener keeps serving. Set `transports.stdio: false` for a headless HTTP-only container to skip the stdio transport (and its startup notice) entirely.

## Standalone binary / MCPB

- `bun build --compile` produces one executable per platform (~80 MB; runtime + native statically linked, no Node/Bun install needed); binaries are built per release — see [Releases](https://github.com/The-40-Thieves/obsidian-tc/releases).
- The **MCPB bundle** (`bun run bundle` → `dist/obsidian-tc.mcpb`) installs one-click into Claude Desktop and other MCPB hosts.

## Edge case: vault on a laptop, agents on a server

**Topology A (recommended)** — server colocated with the vault. obsidian-tc + Obsidian + REST API plugin all run on the laptop; a remote agent tunnels MCP calls to the laptop's HTTP endpoint. Server↔plugin calls stay local; only the agent↔server hop crosses the network.

**Topology B** — server colocated with the agent. Every plugin-bridge call tunnels back to the laptop's Obsidian, incurring RTT per op. Available but not the default.
