---
type: Added
config-schema-change: toolFacade.triadHotPath
---
- **Opt-in hot-path tools on the triad surface.** Set `toolFacade.triadHotPath: true` to list `read_note`, `search_vault`, `write_note` and `list_notes` as top-level tools beside `search` and `fetch`, so an agent's first read or search is one call. Everything else stays behind `find_capability`, `describe_capability` and `call_capability`. Default off. Refs #1457.
