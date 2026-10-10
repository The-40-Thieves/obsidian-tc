# Distribution surfaces

Where obsidian-tc is published or can be listed, what each directory needs, and where it stands.
Written for the maintainer: **nothing in the "not submitted" rows has been submitted**, and none of
it should be without an explicit go-ahead. Vendor documentation was read on 2026-10-10; the source
URL is on every row so the next reader can re-check, because these formats move.

## Status

| Surface | What it takes | Status |
|---|---|---|
| npm (`obsidian-tc`) | `bun run release`, publish workflow | Published (`npm view obsidian-tc version` read 1.32.0) |
| MCP Registry (`io.github.The-40-Thieves/obsidian-tc`) | `server.json`, `mcpName` in the server package | Published (registry API read 1.32.0 as latest). `server.json` validates against the registry's 2025-12-11 schema in CI (`packages/server/test/server-json-schema.test.ts`) |
| Docker image (GHCR) | Release workflow | Shipped per the README; not re-checked here |
| `.mcpb` bundle | `bun run bundle`, attached to each release | Shipped. **Not accepted by Anthropic's connector directory any more**, see below |
| Smithery, glama | `scripts/publish-smithery.mjs`, `glama.json` | Existing listings; not touched or re-checked by this change |
| Claude Code plugin marketplace | `.claude-plugin/marketplace.json` + `plugins/obsidian-tc` | **Live as soon as this is merged**: `claude plugin marketplace add The-40-Thieves/obsidian-tc`. No submission needed for this route |
| Muse Code | `.muse-plugin/plugin.json`, same marketplace file | Built; **format not confirmed against Meta docs** (below). No submission route known |
| Grok Build | reads Claude marketplaces | Documented by xAI as automatic (below). No submission needed |
| Anthropic plugin directory | Submit the plugin in the developer portal | **Not submitted** |
| Anthropic connector directory | A remote HTTPS MCP server | **Not submitted**, and not applicable until a public remote endpoint exists |
| ChatGPT app directory | A remote Streamable HTTP MCP server plus a plugin ZIP | **Not submitted**; the ZIP is not built (below) |
| Cursor / VS Code one-click links | `scripts/gen-install-links.mjs` | Live in README and the install page once merged |

## Claude Code plugin

- Layout: `.claude-plugin/marketplace.json` at the repo root (`name: the-40-thieves`) lists one plugin
  whose source is `./plugins/obsidian-tc`. The plugin holds `.claude-plugin/plugin.json`,
  `.mcp.json` and a README. Sources: [plugins reference](https://code.claude.com/docs/en/plugins-reference),
  [create a marketplace](https://code.claude.com/docs/en/plugin-marketplaces).
- Launcher: `npx -y obsidian-tc@<version>`, stdio, the launcher the README recommends. The config
  file path is a required `userConfig` option (`type: file`) substituted into `OBSIDIAN_TC_CONFIG`.
- The launcher pins the exact package version on purpose. Anthropic's directory **blocks** an
  unpinned `npx` ([pre-submission checklist](https://claude.com/docs/plugins/pre-submission-checklist)),
  so the pin moves with every release.
- Version lockstep: `check:version` asserts both plugin manifests and both launcher pins equal the
  package version, and `release.mjs` writes them from the same list
  (`scripts/lib/plugin-manifest-versions.mjs`). The marketplace entry carries no version, so there
  is no third copy to drift.
- Validation: `claude plugin validate plugins/obsidian-tc --strict` and
  `claude plugin validate . --strict` both pass on Claude Code 2.1.295, and
  `scripts/plugin-manifests.test.mjs` runs them when the CLI is present.

## Grok Build and Muse Code: what was and was not verified

The brief asserted that both load Claude-style `.mcp.json`.

- **Grok Build: confirmed at the level the docs go.** docs.x.ai states that Grok "automatically
  reads Claude Code marketplaces, plugins, skills, MCPs, agents, hooks, and instruction files"
  ([Skills, Plugins & Marketplaces](https://docs.x.ai/build/features/skills-plugins-marketplaces)).
  That page names no file (`.mcp.json`, `.claude-plugin/`), and the MCP page it would live on
  returned 404 (`docs.x.ai/build/features/mcp`). `${user_config.*}` substitution is a Claude Code
  feature, so Grok may pass the placeholder through literally.
- **Muse Code: not confirmed.** Meta's published docs ([Extending and automating](https://dev.meta.ai/docs/muse-code/extending))
  describe MCP only as an `mcp_servers` block in the settings file and do not describe plugins,
  `.mcp.json`, `marketplace.json` or `.muse-plugin/plugin.json`. What is known is second-hand: plugins
  from other vendors ship `.muse-plugin/plugin.json` with `schemaVersion: 1`,
  `compat: {source: native, manifestDir: .muse-plugin}` and `capabilities.mcpServers` as an array
  (dodopayments/dodo-agent-plugin, zombico/mojulo-muse-code, siddicky/oh-my-musecode); one of them
  (muxinc/mux-agent-plugin) says Muse also reads `.claude-plugin/marketplace.json`; a third-party write-up reports the
  plugin system sits behind `MUSE_EXPERIMENTAL_PLUGINS=1`. The one stdio entry I could find
  (oh-my-musecode) is `{id, transport: "stdio", command: [...]}` with `command` as an array, which is
  the shape used here. A vendor with an HTTP-only generator also states stdio entries must not carry
  `command`; the two sources disagree, so **run `muse plugins validate plugins/obsidian-tc` before
  relying on it**. The manifest cannot carry `env`, so `OBSIDIAN_TC_CONFIG` has to be exported in the
  shell that starts Muse.

## Deep links

Generated, not hand-encoded: `node scripts/gen-install-links.mjs` rewrites the marked region in the
README and in `docs/src/content/docs/getting-started/install.md`; `--check` runs in `ci-version`.
`scripts/gen-install-links.test.mjs` decodes every link and compares it with the launch config
derived from `server.json`.

- VS Code: `vscode:mcp/install?<encodeURIComponent(JSON)>`, Insiders `vscode-insiders:`
  ([VS Code MCP guide](https://code.visualstudio.com/api/extension-guides/ai/mcp)).
- Cursor: `cursor://anysphere.cursor-deeplink/mcp/install?name=<name>&config=<base64 JSON>`; the
  config is the server object without the name ([Cursor install links](https://cursor.com/docs/context/mcp/install-links)).
- claude.ai: **no deep link is documented.** The install page carries the manual steps for a custom
  connector ([Anthropic's guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)).

## Claude connector directory: `.mcpb` is closed

Confirmed against Anthropic's [submission guide](https://claude.com/docs/connectors/building/submission):
"desktop extension listings in the directory are deprecated, and the directory no longer accepts local
servers packaged as MCP Bundles (MCPB). To distribute a local server through the directory, include it
in a plugin." (A search engine summary still says the opposite; the page itself is authoritative.) The
`.mcpb` bundle keeps working for hand installs in Claude Desktop and other MCPB hosts. Remote
connectors are submitted separately and need a public `https://` server with OAuth 2.0.

## Tool annotations for directory review

Both OpenAI ([plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines)) and
Anthropic ([review criteria](https://claude.com/docs/connectors/building/submission)) want annotations
stated, not defaulted. OpenAI: "Set `readOnlyHint`, `destructiveHint`, and `openWorldHint` to explicit
boolean values". It also says: "Do not use discovery, operation selection, or schema fetching with a
generic executor to enable operations not individually exposed for review."

- The surface to list is `/mcp/core` (flat mode, core subset): no `find_capability` /
  `describe_capability` / `call_capability`, and none of `execute_command`, `execute_template` or
  `eval_dataview_field` (all outside the core profile).
- Audit result: every tool on that surface already stated all three hints, because they are projected
  from the registry in one place (`toolAnnotations` in `mcp/tool-projection.ts`). The one gap was the
  `call_capability` meta tool, which carried only `openWorldHint`; it now states
  `readOnlyHint: false, destructiveHint: true, openWorldHint: false` (worst case, since it can reach any
  tool). It is not on the core surface, but the triad is the default facade mode.
- `packages/server/test/core-tool-annotations.test.ts` lists tools through a real server for the core
  surface and every other facade mode and fails on any tool missing a hint.
- The description snapshot is unaffected (annotations are not descriptions).
- The brief says the ChatGPT directory accepts Streamable HTTP only. OpenAI's submission page shows
  `"type": "streamable-http"` in its configuration example and says public submission "rejects
  nonempty server headers"; I did not find a sentence stating HTTP-only. The server speaks Streamable
  HTTP at `/mcp` and `/mcp/core`.

## Owner actions (none done)

1. **Anthropic plugin directory.** Open <https://claude.ai/directory/manage>, Submit new, "Plugin
   bundle". Repository `The-40-Thieves/obsidian-tc`, plugin path `plugins/obsidian-tc`, branch `main`.
   First connect GitHub on claude.ai (the account needs push access) and install the Claude GitHub App
   if the repo is private. Use **Validate** and fix any "Blocks" row before submitting. Open items I
   expect it to raise, from the [pre-submission checklist](https://claude.com/docs/plugins/pre-submission-checklist):
   - `plugin.json` has no `icon`, `documentationUrl`, `supportUrl`, `privacyPolicyUrl` or
     `termsOfServiceUrl` yet (all optional for validation, used for the listing; URLs must be https).
     Decide the privacy-policy URL and add it; the plugin README has a short privacy section only.
   - The name `obsidian-tc` contains a brand word ("Obsidian"); the checklist says a name matching a
     known brand is **held for a reviewer**, not blocked. Same for `displayName`.
   - A pinned `npx` launcher is "held for a reviewer" (Runs a pinned npx package), expected.
   - Choose "How new versions reach the directory": GitHub push webhook or scheduled check.
2. **Anthropic connector directory** (only if you stand up a public remote server): same portal,
   "MCP connector", an `https://` MCP URL, OAuth 2.0, a test account for reviewers, a privacy policy
   URL, documentation URL, support contact, icon. Every tool needs a `title` and a read-only or
   destructive hint.
3. **ChatGPT app directory.** Portal: <https://platform.openai.com/plugins> ("Upload new or existing
   plugin", [submission steps](https://developers.openai.com/plugins/deploy/submission)). Needs a
   verified developer identity, a published privacy policy, support contact, a reachable public
   Streamable HTTP MCP URL (use `/mcp/core`; no custom headers on a public submission), a demo
   account if auth is on, and a plugin ZIP in OpenAI's format
   ([Package your plugin](https://developers.openai.com/plugins/build/plugins)). **That ZIP is not
   built here** and is a separate piece of work.
4. **Muse Code.** Install Muse 1.4.0 or later, enable experimental plugins, then run
   `muse plugins validate plugins/obsidian-tc` from a clone and report the output; fix the manifest if
   it disagrees with the shape above. Meta publishes no plugin directory to submit to that I could find.
5. **MCP Registry, npm, Docker, Smithery, glama.** Nothing to do for this change; the next release
   publishes the new `server.json` and plugin files together.
