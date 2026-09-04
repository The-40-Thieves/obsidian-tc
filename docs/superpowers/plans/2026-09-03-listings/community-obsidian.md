# community.obsidian.md submission text — TC Bridge (THE-943)

**Status: PREPARED, NOT SUBMITTED.** Nobody has run the self-service submission flow at
community.obsidian.md and no directory PR/listing exists. This file is the text + checklist for
the owner to paste in when they decide to submit; this task does not submit it.

## Prerequisite: a real release tag must exist first

community.obsidian.md's directory reads `manifest.json` from the plugin repository's default
branch at submission time, and separately expects the **release matching that version** to carry
`main.js`, `manifest.json`, and `styles.css` as individually-downloadable release assets (not
only inside a zip) — that's what BRAT and the directory's own installer fetch.

**As of THE-950, the repo-root `manifest.json` IS `packages/plugin/manifest.json` (byte-identical,
`release.mjs`-mirrored, `check-version-coherence.mjs`-gated).** Before THE-950 the root
`manifest.json` was the MCPB 0.3 bundle manifest (`name: obsidian-tc`, THE-220) — the validator's
default-branch read would have found that file instead of the plugin's, which was a submission
blocker no release tag could have fixed. The MCPB manifest now lives at `mcpb/manifest.json`.

This branch (`gaps/plugin-rename`, THE-943) only renames the manifest; it does not cut a release.
`.github/workflows/publish.yml`'s `build-plugin` job already produces the right release-asset
shape on every tag push (`packages/plugin/dist/{manifest.json,main.js,styles.css}` uploaded loose,
alongside the zipped bundle) — no workflow change is needed to make the NEXT tag correct. Before
submitting:

1. Merge this rename to `main`.
2. Cut the next release (`bun scripts/release.mjs <bump>`, tag, push — standard flow;
   see `docs/G2.5-release-engineering.md`). Note the resulting tag, e.g. `v1.26.0`.
3. Confirm the release's assets include `manifest.json` with `"id": "tc-bridge"` at the release
   URL (`https://github.com/The-40-Thieves/obsidian-tc/releases/tag/<tag>`) before submitting.
4. Fill `<RELEASE_TAG>` below with that tag, then use the text as-is.

## Submission form fields

| Field | Value |
|---|---|
| Repository | `https://github.com/The-40-Thieves/obsidian-tc` |
| Plugin id (from manifest.json) | `tc-bridge` |
| Plugin name | `TC Bridge` |
| Release tag | `<RELEASE_TAG>` (see prerequisite above) |
| Release assets required | `main.js`, `manifest.json`, `styles.css` — all three attached to `<RELEASE_TAG>` as individual files (confirmed present on every tag by the `build-plugin` job) |
| Author | The 40 Thieves |
| Author URL | `https://github.com/The-40-Thieves` |
| License | AGPL-3.0-only |
| minAppVersion | `1.7.0` |
| isDesktopOnly | `true` |

## Description (paste verbatim — matches `packages/plugin/manifest.json`)

> Companion bridge plugin for The 40 Thieves' vault-access MCP server. Extends Local REST API with
> command dispatch and plugin firepower bridges.

## Longer description (for the directory listing page, if it accepts one beyond the manifest field)

> TC Bridge extends the Local REST API plugin with namespaced endpoints an external MCP server
> (`obsidian-tc`) uses for command-palette dispatch, Templater execution, Dataview DQL queries,
> Tasks plugin queries, OCR via Text Extractor, QuickAdd triggers, Smart Connections embeddings,
> Smart Context bundling, and Workspaces/Bookmarks state. It reuses Local REST API's own
> bearer-token auth and opens no port of its own — install and enable Local REST API first. Formerly
> published as "Obsidian Turbocharged" (id `obsidian-tc`); that id is retired and its final release
> only shows a notice pointing installed users at this plugin (see the repo's
> `packages/plugin/legacy/` and `packages/plugin/README.md` "Renamed to TC Bridge" section).

## Rename-specific submission notes (things a reviewer may ask about)

- **This is a rename, not a new plugin from a fork.** The functional history is `obsidian-tc`
  (unlisted, sideload/BRAT-only) renamed to `tc-bridge` to satisfy the directory's "no 'obsidian'
  in a plugin id" rule (verified against `obsidianmd/obsidian-developer-docs`, 2026-09-03) before
  its first-ever directory submission — `obsidian-tc` itself was never submitted or listed, so
  there is no prior listing to migrate or deprecate on Obsidian's side.
- Existing sideload/BRAT users are handled entirely client-side: a settings migration copies
  `.obsidian/plugins/obsidian-tc/data.json` to `.obsidian/plugins/tc-bridge/data.json` on first
  load, and TC Bridge refuses to start (with a notice) if the old `obsidian-tc` plugin is still
  enabled, so the two can never run — and double-register bridge routes — at once.
- Per Obsidian's own guidance, **post-listing renames are unsupported** — this submission is
  therefore the *first and only* id this plugin will ever carry in the directory, submitted after
  the rename rather than before it, specifically to avoid ever needing an unsupported rename later.

## Do NOT submit until

- [ ] This branch is merged to `main`.
- [ ] A tagged release exists with `tc-bridge` in its `manifest.json` and all three loose assets
      attached (checked live at the release URL, not assumed from the workflow).
- [ ] The owner has reviewed this file and explicitly decided to submit.
