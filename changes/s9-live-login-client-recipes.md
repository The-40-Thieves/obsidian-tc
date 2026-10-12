---
type: Changed
---
- **Client recipes now record the 2026-10-12 live OAuth checks.** Claude Code (including `/mcp/essentials`), the claude.ai connector used from Claude Desktop, ChatGPT Plugins, Codex CLI and Antigravity are verified against the bundled authorization server with metadata-document registration and a successful vault tool call. The WorkOS AuthKit recipe records its verified Claude sign-ins and maps `org_id` instead of unavailable role or permissions claims. The Keycloak 26.7 recipe records the `client_not_found` metadata-document issue without claiming a workaround.
