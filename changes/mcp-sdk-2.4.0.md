---
type: Changed
---
- **Bump `@modelcontextprotocol/server` from 2.3.1 to 2.4.0** (and its `@modelcontextprotocol/core` dependency). None of the 2.4.0 upgrade notes applies to this server: no tool uses `x-mcp-header` on a number parameter, no `outputSchema` is built from `.meta({ id })`, and no tool schema sets a `$id` or `$ref` with a URI scheme. Tool names, descriptions and schemas are unchanged, so no client re-approval is needed.
