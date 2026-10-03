---
type: Fixed
---
- **`query_base` counts frontmatter property links, as Obsidian Bases does.** The `link` source, `file.hasLink()` and `file.links` read only body links, so a note linking its target only through a property (`up: "[[Target]]"`, a list property, or an alias form) was missed. They now read property links then body links through one shared list, and a link written in both places is listed once. `file.embeds` stays body-only.
