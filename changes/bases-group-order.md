---
type: Added
tool-description-change: query_base
---
- **query_base honours per-view `groupOrder` (Obsidian 1.14).** A view's `groupOrder` list keeps only the listed groups, in that order (`null` selects the notes with no value), and overrides `groupBy.direction`. Groups not listed are hidden before `limit` applies. Bases without `groupOrder` are unchanged.
