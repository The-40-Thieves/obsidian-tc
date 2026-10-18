---
type: Security
---
- **`/mcp` now enforces the MCP SDK's 4 MiB request-body limit and a 30 s body deadline.** Before, the early JSON check read request bodies with no size or time limit, so an authenticated caller could send a body up to the runtime's own cap (128 MiB under Bun by default). An oversize body is answered 413 and a body that does not arrive within 30 s is answered 408; both close the connection.
