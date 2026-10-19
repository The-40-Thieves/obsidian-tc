---
type: Added
---
- **`find_notes_by_property` says when no readable note has the key.** An empty result now carries a `hint` (`reason: "unknown_property"`) that suggests up to five similar property names, so a misspelled key such as `tag` for `tags`, or `Status` for `status`, no longer looks like a value that matched nothing. Suggestions come only from notes the caller can read.
