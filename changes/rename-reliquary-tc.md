---
type: Changed
config-schema-change: cacheDir
tool-description-change: find_capability, gap_report, get_provenance, note_quality_report, query_base, read_resources, reflect, session_rerun
---
- **obsidian-tc is now Reliquary-TC.** The npm package is `reliquary-tc`, the scoped packages are `@the-40-thieves/reliquary-tc-*`, the command is `reliquary-tc`, environment variables use `RELIQUARY_TC_*`, resource URIs use `reliquary-tc://`, metrics use `reliquary_tc_*` and the default home folder is `~/.reliquary-tc`. Every old name keeps working through 2.x: the `obsidian-tc` command is installed as an alias, `OBSIDIAN_TC_*` variables are read when the new name is unset (with one warning), `obsidian-tc://` URIs are accepted, every metric family is also exposed under its `obsidian_tc_*` name, and an install that only has `~/.obsidian-tc` keeps using it. Running `setup` again treats an existing `obsidian-tc` client entry as the server's own, and `--force` replaces it. The companion plugin API is unchanged. Tool descriptions that named the resource scheme now name `reliquary-tc://`, so clients that key approvals to descriptions ask once more for those tools. See `docs/UPGRADING-2.0.md`.
