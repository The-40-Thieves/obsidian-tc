---
type: Changed
---
- **MCP SDK bumped to `@modelcontextprotocol/server` 2.2.0.** Picks up the SDK's fixes for an unhandled rejection on a closed connection, a `createMcpHandler` stack overflow when the factory reuses one instance, and `subscriptions/listen` end-of-life handling. The server code needed no change: it constructs no OAuth `expectedIssuer` and uses no client-side list helpers. The test-only `@modelcontextprotocol/sdk` (v1) devDependency moves to 1.31.0; migrating those tests to `@modelcontextprotocol/client` stays a follow-up.
