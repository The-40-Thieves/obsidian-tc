---
type: Added
tool-description-change: lint_wiki
---
- **`lint_wiki` reports SCHEMA.md convention violations.** Two new checks, `conventions` (one proposal per note that breaks the folder conventions it sits under, listing its warnings) and `conventions_file` (one proposal per SCHEMA.md layer with file warnings). Both are part of the default check set. A fix is proposed as `tool_args` only when it is unambiguous: a disallowed tag gets `remove_tag`, and a scalar with a single allowed value gets `update_frontmatter`. A missing required property never gets a proposed value.
