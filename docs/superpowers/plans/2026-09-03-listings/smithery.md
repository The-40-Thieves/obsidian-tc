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

## Known Smithery defect that does NOT apply to us

`smithery mcp publish <bundle>.mcpb` 400s when the bundle's `manifest.json` declares a `tools`
array: the CLI casts each MCPB tool entry (name + optional description only) into the registry's
`Tool[]` schema, which requires `inputSchema` — a field the MCPB manifest format forbids on tool
entries (`smithery-ai/cli#787`, open as of 2026-09-03; fix PR `#789` not yet merged). The only
documented workaround is to strip `tools` from the manifest before packing.

**This does not affect us.** Checked our root `manifest.json` (MCPB `manifest_version: "0.3"`): it
declares no `tools` array at all — only `"tools_generated": true`, meaning an MCPB host is expected
to fetch obsidian-tc's tool list from the running server rather than reading it out of the static
manifest. No change to `scripts/bundle-mcpb.ts` or `.mcpbignore` is needed for Smithery.

## Bundle check (built locally, 2026-09-03)

`bun run bundle` packs successfully today:

- **Packed size:** 1.34 MB (packer's own report: `package size: 1.3MB`, `unpacked size: 4.2MB`).
- **Files:** 177 included, 933 excluded via `.mcpbignore`.
- **Tool count:** the MCPB manifest does not statically enumerate tools (`tools_generated: true`,
  see above), so the packer reports no tool count of its own. The live count is
  `REGISTERED_TOOL_COUNT = 163` in `packages/server/test/registered-tool-count.ts`, matching the
  163 already in the GitHub description.

## Sources (verified 2026-09-03)

- Publish command + flags: the installed CLI itself — `npx -y @smithery/cli@4.11.1 mcp publish
  --help` and `npx -y @smithery/cli@4.11.1 login --help` — cross-checked against
  <https://smithery.ai/docs/build/publish> (context7 `/smithery-ai/docs`).
- Tools-in-manifest defect: <https://github.com/smithery-ai/cli/issues/787> (open).
- Server page URL shape: <https://smithery.ai/server/@smithery-ai/fetch>,
  <https://smithery.ai/server/exa/api> (existing listings, found via web search).
