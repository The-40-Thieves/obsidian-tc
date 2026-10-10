---
type: Fixed
---
- **Every `tools/call` result now carries a non-empty text block that answers the call on its own.** Clients that drop `content` when `structuredContent` is present (Codex) or render only the text block no longer risk showing the model nothing. The guarantee is applied once, where every result leaves the server, so it covers direct, facade and domain calls, guard refusals and the SDK shim's own results; a result that already has a text block is returned unchanged, so no payload is doubled. A tool that returns no data now says so in words instead of the literal `null`.
