# mcp.so listing — obsidian-tc (THE-945)

**Status: PREPARED, NOT SUBMITTED.** No submission or issue comment has been posted. This file is
the text + steps for the owner to use when they decide to submit; this task does not submit it.

mcp.so (<https://mcp.so>, directory repo `chatmcp/mcp-directory`) is a community-run MCP
directory. Unlike Glama and PulseMCP (see `checklist.md`), it does **not** scrape the official MCP
Registry — it needs its own submission.

## Two current submission paths (verified 2026-09-03)

1. **Self-service form — <https://mcp.so/submit> (use this one).** Per the form's own stated scope
   (search-indexed page content; the page itself returned HTTP 403 to a direct fetch today, so this
   line is the one fact in this file not independently re-confirmed by a first-party fetch — eyeball
   the live form before using it): submissions of this kind support **public GitHub MCP servers
   only**. obsidian-tc qualifies (public repo, AGPL-3.0-only). You fill in a draft; saving it
   auto-publishes.
2. **GitHub issue (fallback)** —
   [`chatmcp/mcp-directory#1`](https://github.com/chatmcp/mcp-directory/issues/1), titled "Submit
   Your MCP Servers here," confirmed open and still accepting comments as of 2026-09-03. Its
   instructions are minimal — paste your server's link(s) as a comment and it will be made visible
   on mcp.so (the issue body's own phrasing has a typo in "visible"; not reproduced here). Use this
   if the form rejects the submission (the form's stated scope excludes non-GitHub URLs, clients,
   and private repos — none of which apply to us, but the fallback exists in case the form itself
   is down or behaves differently in practice).

## Text to post

Works for either path — as the form's description field, or as a comment on issue #1:

> **obsidian-tc** — model-agnostic, agent-ready Obsidian MCP server with RBAC, SLSA provenance, and
> native search. 163 tools across 31 domains, multi-vault native, pluggable embeddings. TypeScript +
> Rust, AGPL-3.0-only.
>
> Repo: <https://github.com/The-40-Thieves/obsidian-tc>
> npm: <https://www.npmjs.com/package/obsidian-tc>
> MCP Registry entry: `io.github.The-40-Thieves/obsidian-tc`

## Verify it landed

- Listings on mcp.so follow `https://mcp.so/servers/<slug>`, with `<slug>` assigned by mcp.so at
  submission time (not predictable in advance). Check the owner's own mcp.so account for the
  draft/published entry, or search from the mcp.so homepage for "obsidian-tc" / "The 40 Thieves" —
  an exact search-URL query-string shape was not confirmed today.
- Issue-comment path: a maintainer reaction/comment on issue #1, or the same
  `mcp.so/servers/<slug>` page appearing.

## Sources (verified 2026-09-03)

- Directory repo + issue #1: <https://github.com/chatmcp/mcp-directory/issues/1>.
- Submit-form scope: <https://mcp.so/submit> (indexed content; direct fetch returned 403 today —
  see caveat above).
