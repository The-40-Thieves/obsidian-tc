# Upgrading from obsidian-tc to Reliquary-TC 2.0

obsidian-tc is now **Reliquary-TC**. Version 2.0 changes the names and the licence. It removes
nothing: every old name below keeps working through the 2.x line, and the new name wins wherever
both are set. Old names will be removed in 3.0.

## Licence

2.0 and later are Apache-2.0 (see [LICENSE](../LICENSE) and [NOTICE](../NOTICE)). Releases up to and
including 1.34.x stay AGPL-3.0-only.

## What was renamed

| What | Before | From 2.0 | Old name in 2.x |
|---|---|---|---|
| npm package | `obsidian-tc` | `reliquary-tc` | `obsidian-tc` 2.x is a thin package that installs `reliquary-tc` |
| Scoped packages | `@the-40-thieves/obsidian-tc-*` | `@the-40-thieves/reliquary-tc-*` | old packages are deprecated on npm, not updated |
| Command | `obsidian-tc` | `reliquary-tc` | `obsidian-tc` is installed as an alias |
| Environment variables | `OBSIDIAN_TC_*` | `RELIQUARY_TC_*` | read when the new name is unset, with one warning at startup |
| Resource URIs | `obsidian-tc://<vault>/<path>` | `reliquary-tc://<vault>/<path>` | accepted on read; new URIs are advertised |
| Prometheus metrics | `obsidian_tc_*` | `reliquary_tc_*` | every family is exposed under both names |
| Home folder | `~/.obsidian-tc` | `~/.reliquary-tc` | used if it is the only one present; nothing is moved |
| `cacheDir` default | `.obsidian-tc` | `.reliquary-tc` | as for the home folder; an explicit `cacheDir` is never changed |
| Provenance `_meta` key | `io.obsidian-tc/provenance` | `io.reliquary-tc/provenance` | accepted |
| Advisory subscription key | `io.the40thieves.obsidian-tc/advisory` | `io.the40thieves.reliquary-tc/advisory` | accepted, and echoed back as sent |
| Commit trailers | `Obsidian-TC-*` | `Reliquary-TC-*` | both prefixes are reserved and stripped from caller text |
| Container image | `ghcr.io/the-40-thieves/obsidian-tc` | `ghcr.io/the-40-thieves/reliquary-tc` | old tags stay; no new ones |
| MCP Registry | `io.github.The-40-Thieves/obsidian-tc` | `io.github.The-40-Thieves/reliquary-tc` | old entry marked deprecated |
| Repository | `github.com/The-40-Thieves/obsidian-tc` | `github.com/The-40-Thieves/reliquary-tc` | GitHub redirects the old URL |

## What did not change

- The TC Bridge companion plugin keeps its id (`tc-bridge`) and its API (`/obsidian-tc/v1/*`
  routes, `obsidianTcApiVersion`). A 1.x plugin works with a 2.0 server and the other way round.
- Per-vault trace folders from before session traces moved into the cache database keep their path
  (`.obsidian-tc/traces`), so the maintenance sweep still finds and ages them out.
- Config file contents. No key was renamed.
- The database. No migration runs for the rename.

## Moving to the new names

None of this is required for 2.x.

1. Swap the package, old one first (both install an `obsidian-tc` command, so npm refuses to
   install the new one beside the old): `npm rm -g obsidian-tc && npm i -g reliquary-tc`.
2. Rename `OBSIDIAN_TC_*` variables to `RELIQUARY_TC_*` in your shell profile, service unit,
   container environment or client config.
3. In each MCP client config, rename the `obsidian-tc` server entry to `reliquary-tc` and its
   command to `reliquary-tc`. `reliquary-tc setup --force` does this for clients whose config file
   it edits directly; for clients it configures through their own CLI, remove the old entry there.
4. Update dashboards and alerts from `obsidian_tc_*` to `reliquary_tc_*`.
5. Optionally move the home folder while the server is stopped:
   `mv ~/.obsidian-tc ~/.reliquary-tc`. If your config sets `cacheDir` to the old path, update it too.
