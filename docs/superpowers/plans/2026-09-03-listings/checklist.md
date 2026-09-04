# Post-release directory listings checklist (owner-fired, THE-945)

Ordered list of what to fire or confirm once `v1.26.0` tags and `publish.yml` finishes (see
`docs/RELEASING.md`). **Nothing in this file is executed by this task** — every action below is the
owner's to run, in this order: item 1 is a prerequisite for items 4-7, and item 3 has its own
release-tag prerequisite.

## 1. MCP Registry entry — automatic, confirm only

- Fires on the `v*` tag push, no owner action to trigger it (`publish.yml`'s `publish-registry`
  job, THE-940).
- Verify:
  ```sh
  curl -fsS "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.The-40-Thieves%2Fobsidian-tc" | jq .
  ```
- Expected: a non-empty `servers` array whose `version` equals the tagged version (e.g. `1.26.0`).
  An empty `servers: []` means **not published**, not a stale cache.

## 2. GitHub repository description + topics — manual, owner

- Command: `gh repo edit The-40-Thieves/obsidian-tc --description "<text>"` (or the GitHub UI,
  Settings), per the exact current wording in `docs/RELEASING.md`'s step 7.
- Expected: the "N tools across M domains" phrase matches `REGISTERED_TOOL_COUNT` (163 as of this
  task) and `docs/project-facts.json`'s `domainCount` (31).
- Verify: `gh repo view The-40-Thieves/obsidian-tc --json description,repositoryTopics`.

## 3. Community store listing — TC Bridge companion plugin — manual, owner

- Text already prepared (THE-943): the file at
  `docs/superpowers/plans/2026-09-03-listings/community-obsidian.md` — do not duplicate its
  content here. It carries its own release-tag prerequisite and "Do NOT submit until" checklist
  (a tagged release must exist with `tc-bridge` in `manifest.json` and all three loose assets
  attached).
- Command/URL: submit via the **self-service form at
  [community.obsidian.md](https://community.obsidian.md)** using that file's text — sign in with
  an Obsidian account, link the GitHub account that owns the repo to verify ownership, and submit.
  This is not a PR against `obsidianmd/obsidian-releases`; that repo-PR flow is Obsidian's
  pre-self-service submission path and is no longer how new plugins are listed (confirmed against
  `obsidianmd/obsidian-developer-docs`'s "Submit your plugin" doc, 2026-09-04). The form reads
  `manifest.json` from the repo's default branch (THE-950: that is now this repo's root
  `manifest.json`, byte-identical to `packages/plugin/manifest.json`).
- Verify: the submission is confirmed in the community.obsidian.md account dashboard; once
  reviewed and published, `tc-bridge` appears in Obsidian's in-app community plugin browser.

## 4. Smithery — manual, owner

- Full steps + citations: [`smithery.md`](./smithery.md) (this task).
- Command: `smithery login`, then `bun run bundle`, then
  `smithery mcp publish ./dist/obsidian-tc.mcpb -n <qualified-name>`.
- Expected: the CLI prints a server URL on success.
- Verify: open the printed URL (`https://smithery.ai/server/<qualified-name>`) and confirm the
  listing shows the current version, description, and a link back to the GitHub repo. **Check the
  actual page, not just a clean CLI exit** — `smithery.md`'s defect section documents an open bug
  (`arcadeai-labs/smithery-cli#787`) where our exact manifest shape (no `tools`, `tools_generated:
  true`) has produced either a hard `400 {"error":"No values to set"}` with no listing at all, or a
  live listing showing "No capabilities found."

## 5. mcp.so — manual, owner

- Full steps + citations: [`mcp-so.md`](./mcp-so.md) (this task).
- Primary: comment on [`chatmcp/mcpso#1`](https://github.com/chatmcp/mcpso/issues/1) with the repo
  link — free, no review gate mentioned. Optional: <https://mcp.so/submit>, a **$39 one-time paid**
  submission (publish without review, verified badge, featured placement, dofollow link) — the
  owner's call, not a default.
- Verify: the listing appears at `https://mcp.so/servers/<slug>` (slug assigned by mcp.so — search
  the mcp.so homepage for "obsidian-tc" or "The 40 Thieves" if the slug isn't obvious).

## 6. Glama — automatic, confirm only (no submission)

- Glama scrapes the official MCP Registry directly; it does not take a submission. Nothing to fire
  once item 1 is live. Per the registry's own aggregator guidance, aggregators poll "on a regular
  but infrequent basis (e.g., once per hour)"
  (<https://modelcontextprotocol.io/registry/registry-aggregators>).
- Verify: <https://glama.ai/mcp/servers?query=obsidian-tc> shows the listing. May lag the registry
  publish by up to the aggregator's own poll interval — absence after a day is worth an owner
  glance, not an alarm.

## 7. PulseMCP — automatic, confirm only (no submission)

- Same mechanism as Glama — scrapes the official registry, no submission, nothing to fire beyond
  item 1.
- Expected: an obsidian-tc listing at `https://www.pulsemcp.com/servers/<slug>` (slug assigned by
  PulseMCP), showing the registry description and linking back to the GitHub repo — same shape and
  same lag caveat as item 6.
- Verify: browse/search <https://www.pulsemcp.com/servers> for "obsidian-tc" or "The 40 Thieves";
  an exact search query-string shape was not confirmed today, so use the on-page search box rather
  than a constructed URL.

## Ordering note

Items 1-2 depend only on the tag (1 fires itself; 2 is a same-day owner action). Items 3-5
additionally depend on release assets actually being present — item 3 needs the `tc-bridge`
manifest/asset trio on the release; Smithery and mcp.so just need the repo plus a real published
version, which items 1-2 already establish. Items 6-7 need nothing from the owner beyond item 1
landing, so they are the last thing to check, not the first thing to chase.
