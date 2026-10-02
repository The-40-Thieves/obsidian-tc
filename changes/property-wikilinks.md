---
type: Added
---
- **Wikilinks in properties are links.** `author: "[[Douglas Adams]]"` and list properties of quoted links now count in `get_outgoing_links`, `get_backlinks`, `find_unresolved_links`, `find_orphans`, `vault_health_score` and the attachment reference scan, as in Obsidian (`frontmatterLinks`, 1.4.0+). Each property link carries `source: "property"` and its `property`; body links are unchanged, and ACL, unresolved and Excluded-files handling are the body rules. The graph index records them as `property_link` edges, which `vault_graph_search` follows only with `retrieval.densify.includeInWalk`, so default ranking does not change. Only quoted links count, as in Obsidian. `move_note` and `rewrite_link` already rewrote them; that is now pinned by tests.
