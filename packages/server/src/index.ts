// Public entry for the obsidian-tc server core (M0 walking skeleton).
//
// This barrel exposes the foundation pieces that are implemented and verified
// in M0: the synchronous Database interface, the migration runner, folder ACL,
// canonical args hashing, the audit event_log writer, the tool-registry
// dispatch pipeline, and the server_health admin tool.
//
// Runtime concerns deferred to later milestones (M0-completion onward) are
// intentionally NOT wired here: the concrete DB adapters (better-sqlite3 /
// bun:sqlite), the MCP SDK STDIO + Hono Streamable-HTTP transports, and the
// napi-rs native binding. They bind against the interfaces re-exported below.
export * from "./db/types";
export * from "./db/migrate";
export * from "./acl";
export * from "./audit";
export * from "./hash";
export * from "./mcp/registry";
export * from "./tools/admin/health";
