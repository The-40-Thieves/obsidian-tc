---
type: Added
---
- **`retrieval.useSearchModePreference`: `search_vault` can use a caller's learned mode (off by default).**
  `preferred.search_mode` has been written by `obsidian-tc reflect` since extraction landed, but nothing read
  it on the serve path. With the flag on, a `search_vault` call that names no `mode` consults that caller's
  profile for the target vault and, when the stored value is `search_text` at profile weight 3.0 or more,
  runs `mode=text` instead of `auto`. An explicit `mode` (including an explicit `auto`) always wins, an
  object query is never affected, and the stored key is caller-scoped, so another principal's row and the
  shared partition are never read on a named caller's behalf. The other stored values (`search_regex`,
  `search_vault`, `vault_graph_search`, `search_omnisearch`) have no safe `search_vault` counterpart and are
  ignored. With the flag on, `search_vault` reports `mode_source` (`explicit`, `preference` or `default`), a
  label and never content; with it off the tool output and the advertised input schema are byte-identical to
  before. Extraction stays CLI-only on purpose: it re-counts unchanged evidence on every run, so scheduling it
  would inflate weights without new evidence. The eval recorded with this change (the preference arm
  regresses retrieval on every corpus measured) and the ADR-0007 verdict are in the ADR's status section; the
  flag stays off.
