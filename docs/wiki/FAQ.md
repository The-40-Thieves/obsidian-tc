# FAQ

**Do I need the companion plugin?** Only for the command palette and bridge tools (Dataview, Tasks, Templater, OCR, QuickAdd, Excalidraw, Periodic Notes, Workspaces, Bookmarks, make.md, Obsidian Git, Remotely Save). Direct file ops, frontmatter, tags, links, and search over the cache work without it. A tool missing a dependency returns `plugin_missing` naming the plugin. See **[[Plugin Bridges]]**.

**Is my vault data sent anywhere?** No, unless you configure a cloud embedding provider (OpenAI / Voyage / Cohere) or the optional inference gateway — only then do chunks leave your machine, and only to that provider. With the default Ollama provider everything stays local. All tools are `openWorldHint: false`.

**Why do I only see three tools?** That's the default **triad facade**: `find_capability` / `describe_capability` / `call_capability` keep agent context lean while all 141 tools stay reachable (and directly callable by name). Set `toolFacade.mode` to `domain` or `flat` for other shapes. See **[[Tool Reference]]**.

**Does it do GraphRAG / hybrid retrieval?** Yes — shipped and **measured**: `vault_graph_search` (vector seeds + wikilink expansion fused with RRF), FTS5 BM25, and vec0 dense search, gated by an n=250 golden set with a statistical ship rule (contextual chunk enrichment measured +0.223 nDCG and defaults on). Mechanisms that lost their A/B (rerankers, learned sparse, query decomposition) ship dark behind flags with their numbers. See **[[Architecture]]**.

**What is the "work-memory tier"?** A quarantined second store (`experiential.db`) for agent work episodes and retrieval telemetry — physically separate from your authored notes, readable only through eligibility-gated tools (`work_search`, `work_episodes`), with a poison scanner on ingest and a hash-chain-audited `forget`. Content capture is **off by default**. See **[[Architecture]]**.

**Local or cloud embeddings?** Either, per vault. Default is local Ollama (`nomic-embed-text`, 768-dim, with title+breadcrumb chunk context). OpenAI, Voyage, or Cohere are opt-in. A local-Ollama vault and a cloud-Voyage vault coexist in one server. See **[[Configuration]]**.

**Can I serve multiple vaults?** Yes — multi-vault is native. Each vault is isolated: its own SQLite caches, traces, embedding provider, and ACL slice (per-vault ACL overrides supported). Adding/removing a vault needs a restart; editing an existing vault's config can be applied live with `reload_vault`. See **[[Architecture]]**.

**Does it support Bases (`.base`)?** Yes — native, with a real expression-DSL evaluator: `read_base`, `create_base`, `update_base`, `query_base`. Canvas and Excalidraw are supported too.

**How do I expose it to a remote agent safely?** Run the server next to the vault and tunnel the MCP endpoint (Cloudflare Tunnel / SSH forward) — Topology A in **[[Deployment Modes]]**. The server hard-refuses to bind a non-loopback host without JWT auth, so remote exposure forces real auth. See **[[Security and ACL]]**.

**Do I need Rust to install it?** No. Prebuilt native modules ship for **eight platform triples** (linux x64/arm64 × gnu/musl, darwin x64/arm64, win32 x64/arm64). Anything else uses a numerically identical pure-JS fallback. Rust is only needed to build the native module yourself.

**Which MCP clients work?** Any MCP 2025-11-25 client. STDIO for Claude Desktop / Claude Code / Cursor; Streamable HTTP for HTTP local/remote; an MCPB bundle for one-click hosts. The server also exposes MCP Resources and Prompts. HITL uses a custom `elicit_token` pattern, so confirmations work even on clients without native elicitation support.

**How do I confirm a destructive op?** The tool returns `elicit_required` with an `elicit_token`; re-invoke the same tool with that token within 5 minutes. Tokens are single-use and bound to the exact tool + args. Some operations (e.g. `git_commit`, command execution) sit on a hardcoded HITL floor and always confirm. See **[[Security and ACL]]**.

**How do I make the whole server read-only?** Set `acl.readOnly: true` — the kill switch short-circuits every write/delete.

**Is it affiliated with Obsidian?** No. Independent, **AGPL-3.0-only**. "Obsidian" is a trademark of Dynalist Inc.

**Where are the deep docs?** [`ARCHITECTURE.md`](https://github.com/The-40-Thieves/obsidian-tc/blob/main/ARCHITECTURE.md), [`docs/G2.1-tools.md`](https://github.com/The-40-Thieves/obsidian-tc/blob/main/docs/G2.1-tools.md), and the `docs/` Astro Starlight site (quickstart, threat model, cutover guide).
