---
type: Security
---
- **Apply canonical read ACLs to bridge listings and Dataview results.** Tasks, make.md, Omnisearch, Datacore, Git status, template listings, `search_dql` and `search_vault` in `dql` mode now drop a row when any path it reports is invalid (for example a Windows-reserved name such as `CON.md`) or direct note reads would refuse its canonical target, and filter the Dataview `note_paths` list the same way. A bridge result without an `items` array no longer passes its other fields through, and filtered item envelopes always report a `total` counted over the visible rows. Known limit: Dataview rows are attributed only by a Link cell or a task `path`, so a `TABLE WITHOUT ID` row (or a bare path string in a cell) names no path and stays visible to an unrestricted caller.
