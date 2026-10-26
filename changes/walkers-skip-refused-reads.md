---
type: Fixed
---
- **Whole-vault walks skip a note the safe open refuses.** `list_tags`, `suggest_tags`, `find_notes_by_tag`, `list_properties`, `find_notes_by_property`, `query_base`, `list_kanban_boards`, `bundle_folder`, `find_orphans`, `get_backlinks`, `find_unresolved_links`, `audit_provenance`, the graph-health tools, `lint_wiki`, `find_existing_page`, `draft_wiki_page` and `commit_wiki_page` no longer fail when one note is a hard link to a file outside the vault or sits under an unconfigured symlinked folder the safe open refuses. The walk skips reading that note and counts it in `notes_read_refused`, the number of notes skipped, never a path. A listing such as `find_orphans` may still name a path it lists anyway. A clean vault's output has no such key.
