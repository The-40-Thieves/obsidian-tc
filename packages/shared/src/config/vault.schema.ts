// WP1.2: extracted from ../config.schema.ts (which stays a compatibility facade re-exporting
// these same symbol names). Leaf schema — imports Zod and the sibling auth-acl leaf (for the
// per-vault ACL override); no other shared scalars needed here.
//
// Import direction is non-negotiable: this file must never import config.schema.ts or any
// other non-sibling schema module. AclConfigSchema comes from the sibling leaf
// ./auth-acl.schema, never re-derived through the facade — that would be a cycle.
import { z } from "zod";
import { AclConfigSchema } from "./auth-acl.schema";

// Per-vault plugin-bridge timeouts (M4 / THE-180, G2.2 §3.1 + §6). Inner fields
// carry defaults; the whole block is optional so a vault that predates M4
// validates unchanged (consumers read `vault.bridges?.x ?? <default>`).
export const VaultBridgesConfigSchema = z.object({
  timeoutMs: z
    .number()
    .int()
    .positive()
    .default(5000)
    .describe("Timeout in ms for a general plugin-bridge call to this vault's Local REST API."),
  probeTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(500)
    .describe(
      "Timeout in ms for the startup plugin/liveness probe. Deliberately short: it runs before the server is useful, so a dead Obsidian must not stall boot.",
    ),
  ocrTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(30000)
    .describe("Timeout in ms for an OCR bridge call, which is far slower than a normal request."),
  templaterTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(30000)
    .describe(
      "Timeout in ms for a Templater bridge call, which may run arbitrary user template logic.",
    ),
});

// Per-vault probe overrides (M4 / THE-180, G2.2 §6). force_enabled/disabled treat
// a plugin as installed/missing regardless of the probe; probe_skip skips the
// startup probe entirely (force_enabled is then the source of truth) — the seam
// CI uses to assert tool behavior without a live Obsidian.
export const VaultPluginsConfigSchema = z.object({
  forceEnabled: z
    .array(z.string())
    .default([])
    .describe("Plugin ids to treat as installed and enabled regardless of what the probe finds."),
  forceDisabled: z
    .array(z.string())
    .default([])
    .describe("Plugin ids to treat as missing regardless of what the probe finds."),
  probeSkip: z
    .boolean()
    .default(false)
    .describe(
      "Skip the startup plugin probe entirely, making forceEnabled/forceDisabled the sole source of truth. The seam CI uses to assert tool behaviour without a live Obsidian.",
    ),
});

// Per-vault command-palette execution policy (M4 / THE-180, G2.1 Domain 26).
// Deny-by-default: execute_command is disabled unless `enabled` is explicitly true,
// and even then only ids in `allowlist` may be fired (and only with a HITL token —
// execute:command is a scope floor). Arbitrary command execution is never silent.
export const VaultCommandsConfigSchema = z.object({
  enabled: z
    .boolean()
    .default(false)
    .describe(
      "Allow execute_command on this vault at all. Deny-by-default: command execution stays off unless this is explicitly true.",
    ),
  allowlist: z
    .array(z.string())
    .default([])
    .describe(
      "Command ids that may be fired when enabled. Only ids listed here run, and only with a HITL token — there is no wildcard.",
    ),
});

// THE-600: the single source of truth for the memory-materialization folder default. Previously
// duplicated three ways — this schema's own `.default("memory")` literal below, a same-valued
// runtime constant in packages/server/src/tools/m5/shared.ts, and (until this fix) a THIRD copy
// hand-duplicated into cli/commands/forget.ts to dodge the no-transport-imports-tool boundary.
// Living here instead lets every consumer (the schema default, the M5 tool runtime default, and
// the CLI's forget/prefetch commands) import ONE value with no cross-boundary import required —
// this module is shared, not a tool.
export const DEFAULT_MEMORY_FOLDER = "memory";

// Per-vault memory-entity materialization config (M5 / THE-181, G2.1 Domain 22).
// Optional + back-compat: a vault predating M5 validates unchanged (consumers read
// `vault.memory?.folder ?? DEFAULT_MEMORY_FOLDER`). `folder` is where create_entity(materialize)
// writes the regenerable .md projection — a normal vault folder so the [[link]]
// graph resolves in Obsidian. SQLite stays the source of truth.
export const VaultMemoryConfigSchema = z.object({
  folder: z
    .string()
    .min(1)
    .default(DEFAULT_MEMORY_FOLDER)
    .describe(
      "Vault folder where create_entity(materialize) writes the regenerable .md projection. A normal folder so the [[link]] graph resolves in Obsidian; SQLite remains the source of truth.",
    ),
});

// Per-vault workspace-session trace config (M5 / THE-181, G2.1 Domain 23). Session
// traces are append-only JSONL written vault-relative (path-safe via resolveVaultPath
// + ACL-checked via enforcePathAcl) under this folder; default a dot-folder so they
// stay out of Obsidian's graph view. (G2.3 sketched cache_dir; THE-181's DoD requires
// ACL-checked, hence vault-relative.)
export const VaultWorkspaceConfigSchema = z.object({
  traceFolder: z
    .string()
    .min(1)
    .default(".obsidian-tc/traces")
    .describe(
      "Vault-relative folder for append-only JSONL session traces. Defaults to a dot-folder so traces stay out of Obsidian's graph view.",
    ),
});

export const VaultConfigSchema = z.object({
  id: z
    .string()
    .min(1)
    .describe("Stable identifier for this vault. Tools take it as their `vault` argument."),
  name: z
    .string()
    .min(1)
    .optional()
    .describe("Human-readable display name. Defaults to the id when absent."),
  path: z.string().min(1).describe("Absolute path to the vault directory on disk."),
  // P1.5 (audit THE-562): a code-enforced isolation property. WHAT IS ENFORCED (one-directional):
  // the read:docs tools (knowledge_search / knowledge_get_critical) refuse any vault whose kind is
  // not `docs`, so a misprovisioned read:docs token can never read the private vault even if it
  // names its id. `private` = the personal vault (the default); `docs` = the external docs corpus the
  // read:docs surface is bound to; `system` = a reserved internal vault. NOT yet enforced: the
  // reverse — the private read:notes tools (vault_graph_search, read_note, write_note, …) are NOT
  // fenced out of a docs/system vault, so a docs corpus is read-only by convention, not by kind. The
  // reverse gate (reject write/notes access to a docs/system vault) is a tracked follow-up.
  kind: z
    .enum(["private", "docs", "system"])
    .default("private")
    .describe(
      "Isolation kind, enforced one-directionally: the read:docs tools (knowledge_search/knowledge_get_critical) refuse any vault whose kind is not `docs`. `private` (default) = personal vault; `docs` = external docs corpus the read:docs surface is bound to; `system` = reserved internal vault. Not yet enforced: the private read:notes tools are NOT fenced out of a docs/system vault (a follow-up).",
    ),
  // THE-295: per-vault ACL override (same shape as the root `acl` block); absent -> the root
  // ACL is the inherited default. z.lazy defers the reference (AclConfigSchema is declared
  // below this schema).
  acl: z
    .lazy(() => AclConfigSchema)
    .optional()
    .describe(
      "Per-vault ACL override, same shape as the root `acl` block. Absent means the root ACL is inherited.",
    ),
  restApiUrl: z
    .string()
    .url()
    .optional()
    .describe("Base URL of this vault's Obsidian Local REST API, used for live-mode bridge calls."),
  restApiKey: z
    .string()
    .optional()
    .describe(
      "Bearer token for the Local REST API. Secret — never logged or echoed in a tool result.",
    ),
  // Headless mode selection (THE-255). Absent or `auto` probes the Local REST API once at
  // startup: reachable -> live (full surface), else headless (direct-atomic-fs vault state;
  // Tier-3 action tools degrade to requires_live_obsidian). `live`/`headless` force the mode
  // and skip the probe. Optional, so a config predating THE-255 validates unchanged;
  // resolveMode treats an absent mode as auto.
  mode: z
    .enum(["live", "headless", "auto"])
    .optional()
    .describe(
      "How this vault is reached. `auto` (the default when absent) probes the Local REST API once at startup: reachable means live, otherwise headless direct-filesystem access with Tier-3 action tools degrading to requires_live_obsidian. `live`/`headless` force the mode and skip the probe.",
    ),
  bridges: VaultBridgesConfigSchema.optional().describe(
    "Per-vault plugin-bridge timeouts. Absent uses the documented defaults.",
  ),
  plugins: VaultPluginsConfigSchema.optional().describe(
    "Per-vault plugin probe overrides, for forcing a plugin present/absent or skipping the probe.",
  ),
  commands: VaultCommandsConfigSchema.optional().describe(
    "Per-vault command-palette execution policy. Absent means command execution is disabled.",
  ),
  memory: VaultMemoryConfigSchema.optional().describe(
    "Per-vault memory-entity materialization settings.",
  ),
  workspace: VaultWorkspaceConfigSchema.optional().describe(
    "Per-vault workspace session-trace settings.",
  ),
});
export type VaultConfig = z.infer<typeof VaultConfigSchema>;
/** The pre-parse shape (defaulted fields optional) — what VaultRegistry accepts, so a raw
 *  `{ id, path }` (kind/name/acl defaulted at use) is valid without a full schema parse. */
export type VaultConfigInput = z.input<typeof VaultConfigSchema>;
/** P1.5: a vault's code-enforced isolation kind. */
export type VaultKind = VaultConfig["kind"];
