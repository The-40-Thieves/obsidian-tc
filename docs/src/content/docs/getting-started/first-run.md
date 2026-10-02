---
title: First Run
description: Write a minimal config, start the server, and connect an MCP client.
---

The fastest way to try it, no install step and no config file:

```sh
npx obsidian-tc /path/to/vault
```

Every note tool and lexical search work immediately. Semantic search is designed to work out of
the box too — a bundled, fully offline embedder handles indexing with no config at all — but see
[Embeddings](/configuration/embeddings/) for where that's actually reachable today (a source
checkout; not yet the `npx`/npm install above or the Docker image, pending the embedder package's
first publish). A config file is the upgrade for everything else: ACLs, human-in-the-loop
confirmation, the generative tier, and choosing a different (Ollama or hosted) embeddings
provider — the rest of this page walks through that path.

## 1. Write a config

obsidian-tc is launched with a path to a **JSON** config file (there is no YAML
support — the loader reads JSON only). Two ways to get one:

### Setup command (recommended)

```sh
obsidian-tc setup
```

`setup` detects your environment **once** and writes an explicit config, rather than
leaving obsidian-tc to detect it again — silently, and possibly differently — every
time it boots. It finds your Obsidian vaults (from the local Obsidian install, or
`--vault <path>` if you'd rather point it at one directly), decides an embeddings
provider (an existing index's provider is always kept; otherwise the bundled local
embedder if it can run here, then a running Ollama with an embedding model already
pulled, else the local embedder anyway with a notice), and prints each decision with
its reason before writing anything. A hosted provider (OpenAI, Voyage, Cohere) is
only ever **suggested** when its API key is present in your environment — `setup`
never picks one automatically, since that would send note content to a third party
without you having said so.

By default it writes `~/.obsidian-tc/config.json` and asks for confirmation before
writing (skip the prompt with `--yes`; preview without writing at all with
`--dry-run`). It refuses to overwrite an existing config unless you pass `--force`,
which backs the old one up first. See `obsidian-tc help` for the full flag list.
A bare `obsidian-tc` with no arguments finds that default path automatically — see
[step 2](#2-start-it) — or point it there explicitly the same way as a hand-written
config below (as an argument, or via `OBSIDIAN_TC_CONFIG`) if you passed `--config`
to write somewhere else. `setup` does not itself register the config with any MCP
client; see [step 3](#3-connect-a-client) for that.

### First-run fallback (running `setup` yourself is still recommended)

If an MCP client launches `obsidian-tc` with **no arguments at all** — the common
shape, since most clients only know the command, not a vault — and no config exists
yet at `~/.obsidian-tc/config.json`, the server runs `setup`'s own detection once,
non-interactively, on your behalf. It only writes a config when the result is
unambiguous: **exactly one** vault found in your local Obsidian install, and no
refusal (the same "never guess an embeddings provider" rule `setup` itself
applies). If zero or several vaults are found, or the decision would need a guess,
nothing is written and the server exits with a hint to run `obsidian-tc setup`
yourself. A stderr line always names what was written and where; run
`obsidian-tc setup` afterwards any time to review or change it — `obsidian-tc
doctor` also flags a config that was auto-written this way. Set
`OBSIDIAN_TC_NO_AUTO_SETUP=1` to disable this fallback and get the plain "no vault
or config given" error back. It only ever runs for a **plain** `obsidian-tc serve`
start with no other argument: `obsidian-tc serve --help`/`-h` always prints usage
instead, and any other flag `serve` does not recognize is a usage error rather than
something the fallback could silently act on.

### Hand-write it

A minimal single-vault config:

```json
{
  "vaults": [{ "id": "primary", "path": "/home/user/vaults/primary" }],
  "cacheDir": "/home/user/.cache/obsidian-tc",
  "auth": { "mode": "none" }
}
```

## 2. Start it

If you used `setup` and kept its default output path (`~/.obsidian-tc/config.json`), a bare
`obsidian-tc` with no arguments finds it — the same fallback `OBSIDIAN_TC_CONFIG` and a
`--config`/positional path both still take priority over:

```sh
obsidian-tc
# obsidian-tc 1.31.8 ready on stdio (vault primary)
```

Otherwise — a hand-written config, or `setup --config <other-path>` — pass the file's actual
path:

```sh
obsidian-tc /path/to/config.json
# obsidian-tc 1.31.8 ready on stdio (vault primary)
```

By default the server speaks the Model Context Protocol over **stdio**, the
trusted local transport: the operator runs the binary against their own vault, so
calls are authenticated with full local scope.

## 3. Connect a client

Point any MCP client at the command. The config path can be an argument or the
`OBSIDIAN_TC_CONFIG` env var — the env form keeps client entries uniform.

`obsidian-tc setup` itself prints ready-to-paste snippets for every known client at
the end of every run. To have it wire one in for you instead of pasting by hand,
add `--install-client <id>` (`claude-code`, `claude-desktop`, `cursor`, `codex`,
`chatgpt`, `antigravity`, `hermes`, `grok`, `vscode`, `opencode`, `windsurf` —
alias `devin-desktop` — `gemini`, `zed`, `devin`, `aider`, `cline`, `roo`,
`continue`, `goose`, `amazonq`, `kiro`, `jetbrains`, `warp`, `augment` — alias
`auggie`):

```sh
obsidian-tc setup --install-client claude-desktop
```

**Claude Desktop, Cursor, and Windsurf/Devin Desktop** — no CLI of their own —
merge an `obsidian-tc` entry into that client's own JSON config
(`claude_desktop_config.json` / `~/.cursor/mcp.json` / `~/.config/devin/
mcp_config.json`, or the pre-rebrand `~/.codeium/windsurf/mcp_config.json` when
that one already exists) without touching any other server already configured
there, backing the existing file up first. It refuses to replace an existing
`obsidian-tc` entry unless you also pass `--force`, and `--dry-run` prints the
entry without writing anything.

**opencode and Zed** merge the same way, into `opencode.json`'s `mcp` key and
`settings.json`'s `context_servers` key respectively — but both files may carry
`//` comments in real configs, so the merge edits the file's TEXT in place
(preserving every comment and every other key) instead of parsing and
re-serializing it.

**Cline, Roo Code, Kiro, and Warp** merge the same JSON way, into each editor's
own settings file (Cline/Roo Code under VS Code's per-extension
`globalStorage`, Kiro's `~/.kiro/settings/mcp.json`, Warp's `~/.warp/.mcp.json`
— the one client here with NO wrapping `"mcpServers"` key; entries sit at the
file's own top level).

**Continue and Goose** merge into a YAML config the same careful way opencode
and Zed do for JSON — Goose's `~/.config/goose/config.yaml` (`extensions` key)
edited in place with comments preserved, and Continue's own standalone
`.continue/mcpServers/obsidian-tc.yaml` (a dedicated per-server file, so a
second run is a duplicate of the whole file, not a merge).

**Amazon Q Developer CLI and JetBrains AI Assistant** have no single
confirmed-stable install path (Amazon Q's mechanism depends on which agent is
active; JetBrains AI Assistant is UI-only with no disclosed on-disk config) —
`--install-client amazonq`/`jetbrains` print instructions instead of guessing
at a write.

**Augment's Auggie CLI** ships its own `auggie mcp add` command (alias
`auggie` also resolves here), added the same way as Claude Code/Codex/Gemini
CLI below.

**Claude Code, Codex CLI, Antigravity, Hermes Agent, Grok CLI, VS Code, Gemini
CLI, and Augment's Auggie CLI** each ship their own `mcp add`-style command, so
`--install-client` prints (and, unless `--dry-run` is given, runs) that
documented command instead of hand-editing the client's own config file:

```sh
claude mcp add --scope user obsidian-tc -- obsidian-tc --config /ABSOLUTE/PATH/TO/config.json
codex mcp add obsidian-tc -- obsidian-tc --config /ABSOLUTE/PATH/TO/config.json
agy mcp add obsidian-tc obsidian-tc --config /ABSOLUTE/PATH/TO/config.json
hermes mcp add obsidian-tc --command obsidian-tc --args --config /ABSOLUTE/PATH/TO/config.json
grok mcp add -s user obsidian-tc obsidian-tc -- --config /ABSOLUTE/PATH/TO/config.json
code --add-mcp '{"name":"obsidian-tc","command":"obsidian-tc","args":["--config","/ABSOLUTE/PATH/TO/config.json"]}'
gemini mcp add obsidian-tc obsidian-tc --config /ABSOLUTE/PATH/TO/config.json
auggie mcp add obsidian-tc --command obsidian-tc --args '--config /ABSOLUTE/PATH/TO/config.json'
```

**ChatGPT and Devin** (the cloud agent — not Devin Desktop, the rebranded
Windsurf editor above) have no local MCP client at all: both reach only a
remote, public HTTPS MCP server. `--install-client chatgpt`/`devin` write
nothing; they print instructions pointing at [Run one shared server for several
clients](https://github.com/The-40-Thieves/obsidian-tc/wiki/Deployment-Modes#run-one-shared-server-for-several-clients)
below, since that HTTP server is what a public HTTPS URL for either to connect
to would front.

**Aider has no MCP support at all** — `--install-client aider` writes nothing
and exits non-zero with that explanation, rather than pretending there is
somewhere to install into.

| `--install-client <id>` | Mechanism |
|---|---|
| `claude-code` | `claude mcp add` |
| `claude-desktop` | merge `claude_desktop_config.json` |
| `cursor` | merge `~/.cursor/mcp.json` |
| `codex` | `codex mcp add` |
| `chatgpt` | instructions only (remote HTTPS) |
| `antigravity` | `agy mcp add` |
| `hermes` | `hermes mcp add` |
| `grok` | `grok mcp add` |
| `vscode` | `code --add-mcp` |
| `opencode` | merge `opencode.json` (comments preserved) |
| `windsurf` (alias `devin-desktop`) | merge `mcp_config.json` |
| `gemini` | `gemini mcp add` |
| `zed` | merge `settings.json` (comments preserved) |
| `devin` | instructions only (remote HTTPS) |
| `aider` | unsupported — exits non-zero |
| `cline` | merge VS Code globalStorage `cline_mcp_settings.json` |
| `roo` | merge VS Code globalStorage `mcp_settings.json` |
| `continue` | write `.continue/mcpServers/obsidian-tc.yaml` (comments preserved) |
| `goose` | merge `~/.config/goose/config.yaml` (comments preserved) |
| `amazonq` | instructions only (no single stable path) |
| `kiro` | merge `~/.kiro/settings/mcp.json` |
| `jetbrains` | instructions only (UI dialog, no disclosed path) |
| `warp` | merge `~/.warp/.mcp.json` (root-level, no wrapping key) |
| `augment` (alias `auggie`) | `auggie mcp add` |

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "obsidian-tc": {
      "command": "npx",
      "args": ["-y", "obsidian-tc"],
      "env": { "OBSIDIAN_TC_CONFIG": "/ABSOLUTE/PATH/TO/config.json" }
    }
  }
}
```

(A globally-installed binary works too: `"command": "obsidian-tc", "args": ["/path/config.json"]`.)

**Claude Code** — one command:

```sh
claude mcp add obsidian-tc --env OBSIDIAN_TC_CONFIG=/ABSOLUTE/PATH/TO/config.json -- npx -y obsidian-tc
```

**Cursor** (`~/.cursor/mcp.json`) and **VS Code** (`.vscode/mcp.json`) use the same
server object — only the wrapper key differs (`mcpServers` vs `servers`). The
repository README has one-click install badges for both.

Optional env vars worth knowing at wiring time: `OBSIDIAN_TC_GATEWAY_URL` turns on
the generative tier ([inference gateway](/configuration/inference-gateway/));
`OBSIDIAN_TC_DEFAULT_VAULT` picks the default when several vaults are configured.
The complete list is in the [configuration reference](/configuration/config-yaml/).

By default `tools/list` advertises the **triad** facade: three meta-tools
(`find_capability`, `describe_capability`, `call_capability`) for progressive
discovery, with every underlying tool still callable by name. Set
`toolFacade.mode: "flat"` to advertise the full surface, or `"domain"` for
~a dozen domain meta-tools; the measured per-client advice is in
[Choosing a facade mode per client](/getting-started/mcp-clients/#choosing-a-facade-mode-per-client).
To serve over HTTP for remote agents, enable the HTTP
transport and JWT auth — see [Authentication](/security/auth-model/) and
[Configuration](/configuration/config-yaml/).

## 4. Optional power-ups

- **Live plugin bridges** (Dataview, Templater, Git, OCR, …): give the vault entry
  `restApiUrl` + `restApiKey` and install the companion plugin — the walkthrough is
  [QUICKSTART step 6](https://github.com/The-40-Thieves/obsidian-tc/blob/main/docs/QUICKSTART.md).
- **The generative tier** (`reflect` synthesis, decision red-teaming, sleep-time
  consolidation): set `OBSIDIAN_TC_GATEWAY_URL` — see
  [Inference gateway](/configuration/inference-gateway/).
- **Every other option** — ACLs, throttles, snapshots, observability exporters,
  tool-surface shaping: the [complete configuration reference](/configuration/config-yaml/).
- **One shared server for several local MCP clients** (Claude Desktop, Claude Code, Cursor, …) on
  the same vault, instead of one stdio subprocess — and one embedding-model load — per client: see
  [Run one shared server for several
  clients](https://github.com/The-40-Thieves/obsidian-tc/wiki/Deployment-Modes#run-one-shared-server-for-several-clients)
  in the wiki.
