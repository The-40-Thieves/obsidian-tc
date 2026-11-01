---
type: Added
---
- **`doctor` names another MCP server on the same vault root.** The new `clients.sameVaultRoot` check reads the MCP client configs it can find (Claude Code, Cursor, Claude Desktop) and lists any other server whose arguments or environment point at a configured vault root, by client label and server key. It never prints a path. It is a hint, always `ok`: it cannot see servers defined elsewhere, and its notes say which configs and entries it could not compare. Refs #1457.
