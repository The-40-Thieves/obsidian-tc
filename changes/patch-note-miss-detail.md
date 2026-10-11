---
type: Added
---
- **`patch_note` and `patch_active_file` say where a missed `replace_text` string is.** A 0-match refusal keeps its message and `invalid_input` code, and its `error.details` now carry `section_resolved` (the section searched, as 1-based body lines), `found_elsewhere` (exact matches outside that section and the heading each sits under) and `nearest` (the closest line in the section with a 0-1 similarity, whitespace and case ignored). A similarity of 1 means the string is present once whitespace and case are normalized; nothing is applied automatically. The details never echo note text.
