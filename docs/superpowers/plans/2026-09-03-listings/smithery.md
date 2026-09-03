# Smithery listing — obsidian-tc (THE-945)

**Status: PREPARED, NOT SUBMITTED.** No `smithery mcp publish` has been run against the real
Smithery registry. This file is the exact steps + citations for the owner to run when they decide
to submit; this task does not submit it.

## Which Smithery flow fits us

Smithery has two distinct paths, and only one fits obsidian-tc:

- **Smithery-hosted deploy** (`smithery.yaml`, `runtime: typescript` or `runtime: container`) —
  Smithery builds and hosts a remote HTTP MCP server from your source. Not us: obsidian-tc is a
  local stdio server distributed via npm + platform binaries + the `.mcpb` bundle, not something we
  want Smithery building or hosting.
- **Registry publish of an artifact we already own** (`smithery mcp publish <url-or-bundle> -n
  <org>/<name>`) — points the registry at a server URL or an MCPB bundle without Smithery hosting
  anything. This is the one that fits. **No `smithery.yaml` is needed for this path** — it is not
  mentioned anywhere in the publish docs or the CLI's own `--help` output (confirmed below).

## Prerequisites

- `@smithery/cli`, current version **4.11.1** (confirmed today via `npm view @smithery/cli
  version`; `npx -y @smithery/cli@4.11.1` avoids a global install if preferred).
- `smithery login` — an interactive browser OAuth flow tying the publish to the owner's own
  Smithery account. Must be run once, by the owner, not from CI (no service-account/token flow is
  documented for this).
- The packed bundle: `bun run bundle` → `dist/obsidian-tc.mcpb` (see *Bundle check* below).

## Exact steps for the owner

1. `npm install -g @smithery/cli` (or prefix every command below with `npx -y
   @smithery/cli@4.11.1`).
2. `smithery login` — completes in the browser, under the owner's own account.
3. From the repo root: `bun run bundle` → produces `dist/obsidian-tc.mcpb`.
4. `smithery mcp publish ./dist/obsidian-tc.mcpb -n <org>/obsidian-tc` — `-n` is the qualified name
   `org/name` the CLI's own `--help` documents. The org segment is whatever namespace the logged-in
   Smithery account controls; **read it off the CLI's own prompts/output rather than assuming
   `the-40-thieves`** — this file was written without a live login session to confirm the exact
   string Smithery assigns.
5. Confirm the listing at the URL the command prints on success. Smithery server pages follow
   `https://smithery.ai/server/<qualified-name>` (confirmed against existing listings, e.g.
   `https://smithery.ai/server/@smithery-ai/fetch` and `https://smithery.ai/server/exa/api` — note
   the leading `@` appears for some orgs and not others, so trust the CLI's printed URL over
   guessing the shape).

## Known Smithery defect — the narrow form does NOT apply to us, but read the whole thread

`smithery mcp publish <bundle>.mcpb` 400s when the bundle's `manifest.json` declares a `tools`
array: the CLI casts each MCPB tool entry (name + optional description only) into the registry's
`Tool[]` schema, which requires `inputSchema` — a field the MCPB manifest format forbids on tool
entries (`arcadeai-labs/smithery-cli#787`, open as of 2026-09-03; fix PR `#789` open, unmerged, and
only patches this narrow case — see below). Checked our root `manifest.json` (MCPB
`manifest_version: "0.3"`): it declares no `tools` array at all — only `"tools_generated": true` —
so **this specific 400 does not fire for us.** No change to `scripts/bundle-mcpb.ts` or
`.mcpbignore` is needed for it.

**But the omit-`tools` shape we already ship is not a clean workaround — read the full thread, not
just the opening report.** Four independent publishers hit related failures on exactly this path
through 2026-08-19, and the thread documents two different outcomes for the "no `tools`,
`tools_generated: true`" shape (our shape):

- **A hard failure that leaves no listing at all.** `vshulcz`, 2026-07-28, on `@smithery/cli`
  4.11.1 (the version this doc pins): the server row is created, then the follow-up update 400s —
  `✗ 400 {"error":"No values to set"}` — leaving "a live but empty listing... does not show up in
  search" (`{"tools":null,"connections":[],"description":""}`).
  - `madeinplutofabio`, 2026-08-19, same CLI version, an 8-tool bundle with `tools_generated: true`
    set explicitly (our exact shape): **publish succeeded**, the bundle runs and its `tools/list`
    returns all 8 tools correctly — but the resulting server page shows **"No capabilities
    found,"** and the thread confirms this zeroes Smithery's Capability Quality score (a *third*
    reporter, `edycutjong`, measured 0/40 there on a bundle whose 14 tools all document their
    parameters — "the metadata exists; there is just no legal way to hand it over").
- The thread does not resolve why one report got the hard 400 and the other got a degraded-but-live
  listing; no comment isolates the difference. Both are still open outcomes as of 2026-09-03.
- **No workaround exists to get complete capability data into a Smithery listing today.** Declaring
  `tools` with `inputSchema` to satisfy the registry is rejected by `mcpb validate` itself before
  packing even starts (`additionalProperties: false` on every MCPB manifest schema version 0.1
  through 0.4, per `edycutjong`'s comment) — the two schemas are mutually exclusive, not just
  awkward to satisfy together. `smithery.yaml` is unrelated to this failure; it belongs to the
  hosted-deploy path we already ruled out above, not the bundle-publish path. PR `#789` (open,
  unmerged) only adds a default `inputSchema: {"type":"object"}` for the narrow declared-`tools`
  case — a later comment (`madeinplutofabio`) flags that default itself as wrong for any tool that
  takes arguments, and proposes publish-time introspection instead; that proposal has no PR yet.

**What this means for the owner:** treat "no error" as necessary but not sufficient. After running
`smithery mcp publish`, open the printed listing URL and check it directly — a `400 {"error":"No
values to set"}` means the listing did not happen and the submission is blocked on
`arcadeai-labs/smithery-cli#787` closing (retry later, or comment on the issue referencing this
repro); a listing that loads but shows "No capabilities found" is live — the thread doesn't confirm
either way whether that outcome shows up in Smithery's own search — with a near-zero Capability
Quality score until the CLI ships a real fix, which is not something a packer or `.mcpbignore`
change on our side can improve.

## Bundle check (built locally, 2026-09-03)

`bun run bundle` packs successfully today:

- **Packed size:** 1.34 MB (packer's own report: `package size: 1.3MB`, `unpacked size: 4.2MB`).
- **Files:** 177 included, 933 excluded via `.mcpbignore`.
- **Tool count:** the MCPB manifest does not statically enumerate tools (`tools_generated: true`,
  see above), so the packer reports no tool count of its own. The live count is
  `REGISTERED_TOOL_COUNT = 163` in `packages/server/test/registered-tool-count.ts`, matching the
  163 already in the GitHub description.

## A note on the repo name

Smithery merged into Arcade.dev — `smithery.ai`'s own homepage now banners "Smithery is now a part
of Arcade.dev!" linking
[the announcement](https://arcade.dev/blog/smithery-joins-arcade) (fetched live today). The CLI
repo cited by the brief this task started from, `smithery-ai/cli`, now redirects to
`arcadeai-labs/smithery-cli` — confirmed via `gh issue view`/`gh pr view` against both slugs; `npm
view @smithery/cli` still resolves `repository` to the old `smithery-ai/cli.git` URL, so nothing is
actionably broken (git host redirects resolve it), but citations below use the canonical location.
The npm package name (`@smithery/cli`) and CLI command (`smithery`) are unaffected.

## Sources (verified 2026-09-03)

- Publish command + flags: the installed CLI itself — `npx -y @smithery/cli@4.11.1 mcp publish
  --help` and `npx -y @smithery/cli@4.11.1 login --help` — cross-checked against
  <https://smithery.ai/docs/build/publish> (context7 `/smithery-ai/docs`).
- Tools-in-manifest defect and the "No values to set" thread: read in full via `gh issue view 787
  --repo arcadeai-labs/smithery-cli --json comments`, plus `gh pr view 789 --repo
  arcadeai-labs/smithery-cli` (open, unmerged) —
  <https://github.com/arcadeai-labs/smithery-cli/issues/787>.
- Server page URL shape: <https://smithery.ai/server/@smithery-ai/fetch>,
  <https://smithery.ai/server/exa/api> (existing listings, found via web search).
