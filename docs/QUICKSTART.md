# Quickstart — install to first governed write in ~5 minutes

This gets obsidian-tc running against your vault, wired into Claude Desktop or Claude
Code, and through your first queries — ending with a governed (human-confirmed) write.

## 1. Install

Pick one:

```bash
# npm (global) — runs under Node >= 24
npm install -g obsidian-tc

# or no install at all — your MCP client launches it via npx (step 3)
npx -y obsidian-tc --help
```

Claude Desktop users can instead grab the prebuilt **`.mcpb` bundle** from the GitHub
Release (or build it with `bun run bundle` → `dist/obsidian-tc.mcpb`) and open it for a
one-click install — it is self-contained under Node 24+ (built-in `node:sqlite`
fallback), no `node_modules` required. If you use the `.mcpb`, skip to step 4.

## 2. Minimal config

A vault `id` and `path` is the minimum; every other field has a default.

`obsidian-tc.config.json`:

```json
{
  "vaults": [{ "id": "main", "path": "/absolute/path/to/your/vault" }]
}
```

The config file path is the **first CLI argument** (or the `OBSIDIAN_TC_CONFIG`
environment variable). Sanity-check it:

```bash
obsidian-tc config show ./obsidian-tc.config.json   # effective config, secrets redacted
obsidian-tc ./obsidian-tc.config.json               # start; logs "ready on stdio" to stderr
```

(Zero-config also works: `obsidian-tc /path/to/your/vault` boots a single vault named
`main`.) For local semantic search, pull the default embeddings model once:
`ollama pull nomic-embed-text` — everything else runs without it.

## 3. Wire into Claude Desktop / Claude Code

**Claude Desktop** — add to `claude_desktop_config.json` (Settings → Developer → Edit
Config):

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

**Claude Code** — one command:

```bash
claude mcp add obsidian-tc --env OBSIDIAN_TC_CONFIG=/ABSOLUTE/PATH/TO/obsidian-tc.config.json -- npx -y obsidian-tc
```

Restart the client. By default the server advertises three meta-tools
(`find_capability` / `describe_capability` / `call_capability`) that front ~141 governed
capabilities — ask your agent to `find_capability` for anything ("append to a note",
"list tags") and it will discover the rest itself.

## 4. First queries

Stdio is the trusted local transport, so these work immediately:

```jsonc
// liveness + build info; also reports index readiness (index.notes_ready, fts_enabled)
server_health {}

// BM25-ranked literal text search (FTS5-accelerated once the boot index settles)
search_text { "vault": "main", "query": "weekly review" }

// read one note: raw content, parsed frontmatter, body, content hash, stat
read_note { "vault": "main", "path": "Projects/obsidian-tc.md" }
```

Via the facade these are `call_capability { "name": "search_text", "args": { ... } }` —
same gates either way.

## 5. A governed write: folder ACL + human-in-the-loop

Now scope what an agent may touch. This config lets it read everything except the
default-denied folders (`.obsidian/**`, `.git/**`, `.trash/**` are always blocked), but
**write only inside `Inbox/`**:

```json
{
  "vaults": [
    {
      "id": "main",
      "path": "/absolute/path/to/your/vault",
      "acl": { "writePaths": ["Inbox/**"], "deletePaths": ["Inbox/**"] }
    }
  ]
}
```

(A top-level `"acl"` block is the inherited default; per-vault `acl` overrides it —
"write vault A, read-only vault B" works in one process.)

- `write_note { "vault": "main", "path": "Inbox/from-agent.md", "content": "..." }` → succeeds.
- The same write to `Projects/…` → fails closed with an ACL denial.

Destructive operations add a second gate: **HITL elicit**. Calling
`delete_note { "vault": "main", "path": "Inbox/from-agent.md" }` does not delete —
it returns `elicit_required` with an `args_hash` binding that exact call. A single-use
confirmation token (5-minute TTL, bound to that vault + tool + argument hash, minted
server-side via the `issueElicitToken` API on operator approval) must be resubmitted on
the identical call:

```jsonc
delete_note { "vault": "main", "path": "Inbox/from-agent.md", "elicit_token": "<token>" }
```

Change any argument and the hash no longer matches; reuse the token and it is already
consumed. The agent cannot mint its own token — that is the point.

## 6. Optional: light up the plugin bridges (live mode)

Everything above runs **headless** — pure filesystem + index. Bridge tools (Dataview
DQL and field eval, Templater, QuickAdd, OCR, Excalidraw, Omnisearch, Datacore,
Metadata Menu, Obsidian Git, the command palette, …) additionally talk to your
*running* Obsidian through the companion plugin:

1. In Obsidian, install + enable **Local REST API** (community plugins). In its
   settings, **enable the non-encrypted (HTTP) server** — loopback only, default port
   `27123` — and copy the API key. (The encrypted port serves a self-signed
   certificate the bridge client does not trust; use the HTTP loopback port.)
2. Install the companion plugin into the vault, then enable it in Obsidian:

   ```bash
   obsidian-tc plugin install --vault /absolute/path/to/your/vault
   ```

3. Give the vault entry the endpoint + key:

   ```json
   {
     "id": "main",
     "path": "/absolute/path/to/your/vault",
     "restApiUrl": "http://127.0.0.1:27123",
     "restApiKey": "<key from Local REST API settings>"
   }
   ```

4. **Restart the server** (or your MCP client). Live/headless mode is resolved once
   at startup by probing `restApiUrl` — `reload_vault` re-validates config but does
   not re-resolve mode. Without these two keys every bridge tool returns the typed
   `requires_live_obsidian` error while the filesystem tools keep working.

Verify with `list_commands { "vault": "main" }` — it answers from the live app, and a
missing third-party plugin surfaces as `plugin_missing` naming the plugin.

## Where next

- [WHY.md](./WHY.md) — the threat model and what each gate buys you
- [COHERENCE.md](./COHERENCE.md) — writing while Obsidian is open
- [CUTOVER.md](./CUTOVER.md) — migrating from another Obsidian MCP server
- Step 6 above — the optional companion plugin (Dataview / Templater / Git / OCR and
  the other live bridges); steps 1–5 work without it
