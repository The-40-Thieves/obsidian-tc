---
type: Added
---
- **`suggest_tags`: the first tool that uses MCP sampling.** It suggests tags for a note, preferring the vault's existing tags. When the client supports sampling it asks the client's own model (`source: client-sampled`); the request is one bounded call that carries the note as untrusted data, only for notes and tags the caller can read, and the reply is parsed strictly or rejected. Otherwise, or if the client declines or answers badly, it falls back to a deterministic match against existing tags (`source: heuristic`) and says why in `sampling.status`. It is read-only: apply a suggestion with `add_tag`. A new `client-sampling` tool tag lets `toolVisibility` hide or disable such tools.
