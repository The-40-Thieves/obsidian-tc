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
//
// Explicit named exports define the M0 public API. Internal helpers
// (glob compilation, migration checksum) stay module-private.
export type { Database, Statement, RunResult } from "./db/types";
export { runMigrations } from "./db/migrate";
export type { Migration, MigrateOptions } from "./db/migrate";
export { FolderAcl } from "./acl";
export type { AclRuleT, AclConfigT } from "./acl";
export { writeEvent } from "./audit";
export type { AuditEvent } from "./audit";
export { argsHash } from "./hash";
export { ToolRegistry } from "./mcp/registry";
export type { CallerContext, ToolDefinition, RegistryOptions } from "./mcp/registry";
export { createHealthTool } from "./tools/admin/health";
export type { HealthInfo } from "./tools/admin/health";
