// Public entry for the obsidian-tc server core (M0 walking skeleton).
//
// This barrel exposes the foundation pieces that are implemented and verified
// in M0: the synchronous Database interface, the migration runner, folder ACL,
// canonical args hashing, the audit event_log writer, the tool-registry
// dispatch pipeline, and the server_health admin tool.
//
// The MCP server assembly (registry -> SDK Server) and the stdio transport are
// wired below (THE-184 / THE-176): the DB adapters (better-sqlite3 / bun:sqlite),
// the Streamable-HTTP transport + JWT edge, folder-ACL enforcement, and the HITL
// elicit store are all implemented and exported here.
//
// Explicit named exports define the M0 public API. Internal helpers
// (glob compilation, migration checksum) stay module-private.

export type { AclConfigT, AclRuleT } from "./acl";
export { FolderAcl } from "./acl";
export type { AuditEvent } from "./audit";
export { writeEvent } from "./audit";
export { loadConfig } from "./config/load";
export type { MigrateOptions, Migration } from "./db/migrate";
export { runMigrations } from "./db/migrate";
export { openDatabase } from "./db/open";
export type { Database, RunResult, Statement } from "./db/types";
export type { IssueElicitInput } from "./elicit";
export { elicitVerifier, issueElicitToken, verifyAndConsumeElicit } from "./elicit";
export { argsHash } from "./hash";
export type { CallerContext, RegistryOptions, ToolDefinition } from "./mcp/registry";
export { ToolRegistry } from "./mcp/registry";
export type { McpServerOptions } from "./mcp/server";
export { createMcpServer } from "./mcp/server";
export type { HealthInfo } from "./tools/admin/health";
export { createHealthTool } from "./tools/admin/health";
export type { HttpAppOptions, HttpHandle } from "./transports/http";
export { createHttpApp, startHttp } from "./transports/http";
export { connectStdio } from "./transports/stdio";
