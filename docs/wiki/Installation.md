# Installation

obsidian-tc ships as an npm package, a container image, a one-click `.mcpb` bundle, and standalone binaries. Pick the install path that matches your deployment — see **[[Deployment Modes]]** for the trade-offs.

## Requirements

| Component | Requirement | Notes |
|---|---|---|
| **Runtime** | **Node `>= 24`** or **Bun `>= 1.1`** | Auto-detected. Under Node the server uses `better-sqlite3` (falling back to the built-in `node:sqlite`); under Bun it uses `bun:sqlite`. |
| **Obsidian** | Any recent version | The vault host. Required for plugin-bridge tools; pure filesystem/search tools work headless. |
| **Local REST API plugin** | `coddingtonbear/obsidian-local-rest-api` | HTTP entry point into the live app. Required for the companion plugin and live-mode bridges. |
| **Companion plugin** | `obsidian-tc` (this project) | Required for the command palette and **any** plugin-bridge tool. See **[[Plugin Bridges]]**. |
| **Ollama** (default embeddings) | `ollama pull nomic-embed-text` | Local 768-dim embeddings; cloud providers (OpenAI / Voyage / Cohere) are opt-in. |

The Rust toolchain is **only** needed if you build the native module yourself. Every native export has a numerically identical pure-JS fallback, so a missing prebuild never blocks you.

## Install via npm (recommended)

```bash
npm install -g obsidian-tc
obsidian-tc /path/to/your/vault   # zero-config: single vault "main", all defaults
```

The install pulls a prebuilt native module for your platform from `optionalDependencies`. Eight triples ship:

```
@the-40-thieves/obsidian-tc-native-linux-x64-gnu
@the-40-thieves/obsidian-tc-native-linux-arm64-gnu
@the-40-thieves/obsidian-tc-native-linux-x64-musl
@the-40-thieves/obsidian-tc-native-linux-arm64-musl
@the-40-thieves/obsidian-tc-native-darwin-x64
@the-40-thieves/obsidian-tc-native-darwin-arm64
@the-40-thieves/obsidian-tc-native-win32-x64-msvc
@the-40-thieves/obsidian-tc-native-win32-arm64-msvc
```

Any platform without a prebuild (or with `OBSIDIAN_TC_FORCE_JS_FALLBACK=1`) uses the pure-JS fallback automatically.

## Install via Docker

```bash
docker run -v /path/to/vault:/vault \
  ghcr.io/the-40-thieves/obsidian-tc:1.7.0 /vault
```

The native module is prebuilt into the image. The vault is bind-mounted; your Obsidian (with the companion + Local REST API plugins) runs on the **host**, not in the container. On Linux use `--network host` so the container can reach Obsidian's REST API plugin; on macOS/Windows map the port explicitly.

## MCPB bundle / standalone binary

- **MCPB**: a prebuilt `obsidian-tc.mcpb` bundle gives one-click install in Claude Desktop and other MCPB hosts (built from source via `bun run bundle`).
- **Standalone binary**: platform binaries (~80 MB, runtime + native statically linked, no Node/Bun install needed) are built per release — see the [Releases page](https://github.com/The-40-Thieves/obsidian-tc/releases).

## Install the companion plugin

1. Install and enable **Local REST API** in Obsidian (Community Plugins). Copy its API key from the plugin settings.
2. Install the **obsidian-tc** companion plugin — easiest via the CLI, then enable it in Obsidian:

   ```bash
   obsidian-tc plugin install --vault /path/to/your/vault
   ```

   It registers `/obsidian-tc/v1/*` routes on the REST API plugin's port (default `127.0.0.1:27124`).
3. Mirror the REST API key into your config (`vaults[].restApiKey`) — see **[[Configuration]]**.

Direct file operations (`read_note`, `write_note`, search over the cache, …) work without the companion. Plugin-bridge tools (Dataview, Tasks, Templater, OCR, Git, …) additionally require the companion plugin and the specific third-party plugin — a missing link returns `plugin_missing` naming the plugin. See **[[Plugin Bridges]]**.

## Connect an MCP client

**STDIO (Claude Desktop / Claude Code / Cursor / VS Code):**

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

(Or `"command": "obsidian-tc"` for a global install. The config path can also be the first CLI argument — including just a vault folder for zero-config.)

**HTTP:** enable the HTTP transport in the config (`transports.http.enabled: true`, default `127.0.0.1:8765`) and connect clients to `http://127.0.0.1:8765`. An unauthenticated server refuses to bind a non-loopback host — remote exposure requires JWT (see **[[Security and ACL]]**).

## Verify the install

Call the `server_health` tool — it round-trips the full transport → auth → ACL → audit path and returns liveness plus build info. `list_vaults` confirms your vault registry loaded. From the shell: `obsidian-tc version` and `obsidian-tc config show ./obsidian-tc.config.json` (secrets redacted).

## Build from source

```bash
git clone https://github.com/the-40-thieves/obsidian-tc.git
cd obsidian-tc
bun install        # native falls back to pure-JS if Rust is absent
bun run build
bun run test
```

Full dev setup is in **[[Contributing]]**.
