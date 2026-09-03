# mcp.so listing — obsidian-tc (THE-945)

**Status: PREPARED, NOT SUBMITTED.** No submission or issue comment has been posted. This file is
the text + steps for the owner to use when they decide to submit; this task does not submit it.

mcp.so (<https://mcp.so>, directory repo `chatmcp/mcpso` — see *A note on the repo name* below) is
a community-run MCP directory. Unlike Glama and PulseMCP (see `checklist.md`), it does **not**
scrape the official MCP Registry — it needs its own submission.

## Two current submission paths (verified 2026-09-03, both fetched directly)

1. **GitHub issue — free (use this one).**
   [`chatmcp/mcpso#1`](https://github.com/chatmcp/mcpso/issues/1), titled "Submit Your MCP Servers
   here," confirmed open and still accepting comments as of 2026-09-03 (checked live via `gh issue
   view`). Its instructions are minimal — paste your server's link(s) as a comment and it will be
   made visible on mcp.so (the issue body's own phrasing has a typo in "visible"; not reproduced
   here). No payment, no account, no review gate mentioned.
2. **Self-service form — <https://mcp.so/submit> — paid, $39 one-time.** Fetched the live page in
   full today (not just indexed text — the earlier 403 to a direct fetch was a tool limitation, not
   the page's actual state; a different fetch path retrieved it cleanly). The form has exactly one
   option: **"Paid submission — $39 one-time publishing fee"**, bulleted as "Publish immediately
   without review," "Verified badge," "Featured and priority placement," and "Dofollow project
   link," with a single **"Pay and submit automatically"** button. No free/organic draft field is
   visible anywhere on the page. What the fee buys, beyond skipping the (unspecified) review queue,
   is a verified badge, featured/priority placement, and a dofollow backlink — none of which affect
   whether obsidian-tc is discoverable, only how prominently. **This is the owner's call, not a
   default** — the fallback framing this doc used in an earlier draft had it backwards; the free
   issue path is the one with no cost or review gate, so it leads.

## Text to post

Works for either path — as a comment on issue #1, or as the form's description field if the owner
pays:

> **obsidian-tc** — model-agnostic, agent-ready Obsidian MCP server with RBAC, SLSA provenance, and
> native search. 163 tools across 31 domains, multi-vault native, pluggable embeddings. TypeScript +
> Rust, AGPL-3.0-only.
>
> Repo: <https://github.com/The-40-Thieves/obsidian-tc>
> npm: <https://www.npmjs.com/package/obsidian-tc>
> MCP Registry entry: `io.github.The-40-Thieves/obsidian-tc`

## Verify it landed

- Listings on mcp.so follow `https://mcp.so/servers/<slug>`, with `<slug>` assigned by mcp.so at
  submission time (not predictable in advance). Search from the mcp.so homepage for "obsidian-tc" /
  "The 40 Thieves" — an exact search-URL query-string shape was not confirmed today.
- Issue-comment path: a maintainer reaction/comment on issue #1, or the same
  `mcp.so/servers/<slug>` page appearing (may take longer to be actioned than the paid path, which
  states "immediately without review").

## A note on the repo name

`chatmcp/mcp-directory` (cited in the brief this task started from) now redirects to
`chatmcp/mcpso` — confirmed via `gh repo view`/`gh api repos/chatmcp/mcp-directory`, which resolve
to `https://github.com/chatmcp/mcpso`. Issue #1 is the same issue at the new location
(`chatmcp/mcpso#1`), same title, same open state. Citations below use the canonical URL.

## Sources (verified 2026-09-03)

- Directory repo + issue #1 (canonical): <https://github.com/chatmcp/mcpso/issues/1> — fetched live
  via `gh issue view 1 --repo chatmcp/mcpso` and `mcp__crawl4ai__md`.
- Submit-form content and pricing: <https://mcp.so/submit> — fetched live in full via
  `mcp__crawl4ai__md` (raw mode) today, superseding this doc's earlier indexed-content-only read.
