import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import type { z } from "zod";
import type { CallerContext, RegistryOptions, ToolDefinition } from "./types";

// WP4.3: input binding, pulled out of registry.ts's runDispatch UNCHANGED. Covers the three gates
// that decide WHICH vault and WHOSE ACL the rest of dispatch runs under, before any authorization
// decision is made against that vault: the input-schema parse, the THE-267 vault-binding guard, and
// the THE-295 per-vault ACL swap. Each function throws (or mutates ctx) exactly as the inline block
// it replaces did; the audit/meter/episode reaction to a thrown error stays in dispatch.ts, which
// already has a single catch-all for every stage.

/** THE-513 Part 2: the caller-supplied target vault id for this call, read from the tool's
 *  declared `vaultArg` field (defaulting to "vault", the name every tool used before this field
 *  existed) — the single place every call site below resolves it, instead of each hardcoding
 *  `.vault` on the parsed input. */
export function vaultArgOf(def: ToolDefinition, data: unknown): string | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const v = (data as Record<string, unknown>)[def.vaultArg ?? "vault"];
  return typeof v === "string" ? v : undefined;
}

/** Input-schema validation stage: the first thing runDispatch does, before auth/scope/ACL. */
export function parseInput<I>(def: ToolDefinition<I, unknown>, rawInput: unknown): I {
  const parsed = def.inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    // THE-1042 (GH #935): a caller sees WHICH key was rejected (THE-823) but not what to send
    // instead. STRUCTURED first (this hint), rendered second (mcp/error-rendering.ts reads these
    // same fields) — a programmatic caller gets it without parsing the text block.
    const hints = unrecognizedKeyHints(def as unknown as ToolDefinition, parsed.error.issues);
    throw new ObsidianTcError("validation_error", "input validation failed", {
      issues: parsed.error.issues,
      ...hints,
    });
  }
  return parsed.data;
}

// ── THE-1042 (GH #935): unrecognized-key fix hints ──────────────────────────────────────────────

/** Zod4 wrapper kinds `.unwrap()` peels through on the way to the object/union underneath —
 *  optional/default/nullable and their variants. Anything else stops the walk. */
const UNWRAPPABLE_SCHEMA_KINDS = new Set([
  "optional",
  "nullable",
  "default",
  "readonly",
  "catch",
  "prefault",
  "nonoptional",
]);

/** The minimal surface this module introspects on a zod schema instance — narrower than `z.ZodType`
 *  so a schema-shape walk needs no runtime zod import, only the classic API's public `.def`,
 *  `.shape`, `.options`, `.unwrap()` (all documented, stable across zod4 point releases). */
interface IntrospectableSchema {
  def?: { type?: string };
  shape?: Record<string, IntrospectableSchema>;
  options?: readonly IntrospectableSchema[];
  unwrap?: () => IntrospectableSchema;
}

function unwrapSchema(schema: IntrospectableSchema): IntrospectableSchema {
  let s = schema;
  while (
    typeof s.def?.type === "string" &&
    UNWRAPPABLE_SCHEMA_KINDS.has(s.def.type) &&
    typeof s.unwrap === "function"
  )
    s = s.unwrap();
  return s;
}

/** Accepted key names of the object schema at `schema` (already unwrapped by the caller). A union —
 *  including a discriminated union — contributes the UNION of every member's keys, since the
 *  caller's real target could be any of them. */
function keysOfObjectOrUnion(schema: IntrospectableSchema): string[] | undefined {
  const s = unwrapSchema(schema);
  if (s.def?.type === "object" && s.shape) return Object.keys(s.shape);
  if ((s.def?.type === "union" || s.def?.type === "discriminatedUnion") && s.options) {
    const keys = new Set<string>();
    for (const member of s.options) for (const k of keysOfObjectOrUnion(member) ?? []) keys.add(k);
    return keys.size > 0 ? [...keys] : undefined;
  }
  return undefined;
}

/** Walk `root`'s shape down a zod issue's `path` (e.g. `["filter"]` for an unrecognized key nested
 *  under `filter`) to the object schema an `unrecognized_keys` issue at that path was rejected
 *  against, and return its accepted key names, sorted for a deterministic rendering. Stops (returns
 *  undefined) if the walk runs off the shape — a schema shape this introspection cannot follow
 *  (e.g. through a mid-path union) rather than a wrong tool. */
function acceptedKeysAt(root: z.ZodType, path: ReadonlyArray<PropertyKey>): string[] | undefined {
  let cur = unwrapSchema(root as unknown as IntrospectableSchema);
  for (const seg of path) {
    if (cur.def?.type !== "object" || !cur.shape) return undefined;
    const next = cur.shape[String(seg)];
    if (!next) return undefined;
    cur = unwrapSchema(next);
  }
  const keys = keysOfObjectOrUnion(cur);
  return keys ? keys.sort() : undefined;
}

/** Iterative Levenshtein edit distance — schema key names are short, so the plain O(n*m) DP table
 *  needs nothing cleverer. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prevRow = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const substCost = a[i - 1] === b[j - 1] ? 0 : 1;
      row.push(
        Math.min((row[j - 1] ?? 0) + 1, (prevRow[j] ?? 0) + 1, (prevRow[j - 1] ?? 0) + substCost),
      );
    }
    prevRow = row;
  }
  return prevRow[b.length] ?? Math.max(a.length, b.length);
}

const NEAREST_KEY_MAX_DISTANCE = 2;

/** The nearest accepted key within `NEAREST_KEY_MAX_DISTANCE` edits of `rejected`, or undefined
 *  when nothing is close enough to be a confident typo-fix rather than a different field. */
function nearestKey(rejected: string, accepted: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = NEAREST_KEY_MAX_DISTANCE + 1;
  for (const candidate of accepted) {
    const d = editDistance(rejected, candidate);
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return bestDistance <= NEAREST_KEY_MAX_DISTANCE ? best : undefined;
}

/** GH #935: cross-tool spelling aliases edit distance cannot catch — the "scope this call to a
 *  folder" argument is spelled `root` on the search/scan family and `folder` on the
 *  listing/metadata family, 4+ edits apart either way, so `nearestKey` alone never bridges them.
 *  Swept from every `root:`/`folder:` scoping field under tools/ (2026-09-13); no tool anywhere
 *  takes `dir`. Keyed by tool name, then by the REJECTED key -> the one that tool actually accepts. */
const ROOT_SCOPED_TOOLS = [
  "search_text",
  "search_regex",
  "search_semantic",
  "search_jsonlogic",
  "search_vault",
  "query_canvas",
  "bundle_folder",
  "list_tasks",
  "ocr_bulk",
] as const;
const FOLDER_SCOPED_TOOLS = [
  "list_tags",
  "find_notes_by_tag",
  "find_orphans",
  "find_unresolved_links",
  "rewrite_link",
  "list_properties",
  "find_notes_by_property",
  "list_attachments",
  "list_notes",
  "index_vault",
  "list_kanban_boards",
] as const;
const CROSS_TOOL_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  ...Object.fromEntries(ROOT_SCOPED_TOOLS.map((name) => [name, { path: "root", folder: "root" }])),
  ...Object.fromEntries(
    FOLDER_SCOPED_TOOLS.map((name) => [name, { path: "folder", root: "folder" }]),
  ),
};

function pathKeyOf(path: ReadonlyArray<PropertyKey>): string {
  return path.map(String).join(".");
}

/** `details.accepted_keys` / `details.key_hints` for every `unrecognized_keys` issue in one parse
 *  failure, keyed by the issue's path (joined with "."; "" for the top level). `key_hints` names,
 *  per rejected key, the accepted key it probably should have been — the tool's own alias table
 *  first (catches a cross-tool spelling edit distance can't), else the nearest accepted key by edit
 *  distance. Returns undefined when there were no `unrecognized_keys` issues to hint about. */
function unrecognizedKeyHints(
  def: ToolDefinition,
  issues: readonly z.core.$ZodIssue[],
):
  | { accepted_keys: Record<string, string[]>; key_hints: Record<string, Record<string, string>> }
  | undefined {
  const accepted_keys: Record<string, string[]> = {};
  const key_hints: Record<string, Record<string, string>> = {};
  const aliases = CROSS_TOOL_ALIASES[def.name];
  for (const issue of issues) {
    if (issue.code !== "unrecognized_keys") continue;
    const acceptedForPath = acceptedKeysAt(def.inputSchema as z.ZodType, issue.path);
    if (!acceptedForPath) continue;
    const pathKey = pathKeyOf(issue.path);
    accepted_keys[pathKey] = acceptedForPath;
    for (const rejected of issue.keys) {
      const suggestion = aliases?.[rejected] ?? nearestKey(rejected, acceptedForPath);
      if (suggestion) {
        key_hints[pathKey] ??= {};
        key_hints[pathKey][rejected] = suggestion;
      }
    }
  }
  return Object.keys(accepted_keys).length > 0 ? { accepted_keys, key_hints } : undefined;
}

/**
 * Vault-binding guard (THE-267). A vault-bound caller (an HTTP token) may act only on its
 * own vault: the ~90 vault tools resolve a caller-supplied `vault` arg against ANY configured
 * vault under the single global ACL, so without this a token reaches every vault. resources/read
 * already enforces the same invariant. Fires only when a `vault` arg is present, so the execute
 * family (no vault arg) and vault-omitting calls are unaffected; trusted stdio is unbound.
 *
 * THE-514 item 2 — AUTHORITATIVE NOTE on the one place this guard's condition differs from
 * resources.ts's readResource (its `if (vaultId !== ctx.vaultId)` check, which points back
 * here): this check is CONDITIONAL on `ctx.vaultBound === true`, so a trusted stdio caller
 * (vaultBound left unset) may still name any configured vault. readResource's equivalent
 * check is UNCONDITIONAL — it refuses `vaultId !== ctx.vaultId` regardless of vaultBound, so
 * even a trusted stdio caller reading a resource is pinned to its own vault.
 *
 * Same concern (don't let a caller reach a vault it isn't bound to), two behaviours, and this
 * is a DELIBERATE, EVALUATED divergence, not an oversight:
 *   - Tools stay conditional because trusted stdio operators routinely address every
 *     configured vault by name through the `vault` argument (prefetch, admin tools, multi-vault
 *     workflows) — that is the documented meaning of "trusted": no HTTP token, no vaultBound.
 *   - resources/read stays unconditional because listResources only ever emits URIs for
 *     ctx.vaultId (mcp/resources.ts's listResources) — there is no legitimate reason for ANY caller,
 *     trusted or not, to construct a foreign-vault resource URI by hand, so the narrower rule
 *     costs a trusted caller nothing while closing off a hand-crafted URI as an attack surface.
 * The divergence is currently in the SAFE direction (resources is the stricter of the two). If
 * this is ever revisited, that is a security-semantics decision — evaluate it explicitly rather
 * than "fixing" one side to match the other; see the parity gate in
 * dispatch-parity.test.ts ("vault-binding: documented divergence, asserted as such"), which
 * asserts this documented state rather than sameness.
 */
export function enforceVaultBinding(ctx: CallerContext, def: ToolDefinition, data: unknown): void {
  if (ctx.vaultBound !== true) return;
  const requested = vaultArgOf(def, data);
  if (requested !== undefined && requested !== ctx.vaultId)
    throw new ObsidianTcError("forbidden", "vault is not the caller's bound vault", {
      vault: requested,
      bound_vault: ctx.vaultId,
    });
}

/**
 * THE-295: per-vault ACL. When the parsed input names a vault, the remainder of this dispatch
 * (the readOnly gate + every enforcePathAcl in the handler) runs under THAT vault's ACL — the
 * root ACL is the inherited default. Runs AFTER the THE-267 vault-binding guard, so a bound
 * caller cannot reach another vault's ACL. The advertised tool surface (listVisible) deliberately
 * keeps the caller's default ACL; enforcement is per-vault here at dispatch. Mutates `ctx.acl`
 * (property mutation, not param reassignment — ctx objects are per-dispatch), matching the
 * original inline block exactly.
 */
export function applyVaultAcl(
  ctx: CallerContext,
  def: ToolDefinition,
  data: unknown,
  aclResolver: RegistryOptions["aclResolver"],
): void {
  if (!aclResolver) return;
  const requestedVault = vaultArgOf(def, data);
  if (requestedVault === undefined) return;
  const vaultAcl = aclResolver(requestedVault);
  if (vaultAcl) (ctx as { acl?: typeof vaultAcl }).acl = vaultAcl;
}

/** Lowercase and drop every character `VaultId` (primitives.ts) does not accept, collapsing runs
 *  into a single "-" — a permissive slugification for the did-you-mean COMPARISON only. This never
 *  feeds resolution: the ruling for GH #935 is that a vault id is never resolved case-insensitively
 *  or by slug, only ever OFFERED as a hint the caller must still send verbatim. */
function slugifyForHint(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * THE-1042 (GH #935): the ONE site that turns a vault failure into a fix hint, for both shapes it
 * takes — the `VaultId` regex/min/max issue `parseInput` throws (still `validation_error`, path
 * `[vaultArg]`), and `vault_not_found` thrown deep inside a handler by `VaultRegistry.resolve`
 * (dispatch.ts's outer catch is the one place both funnel through, so this is called from there
 * rather than patched into each tool). Adds `details.visible_vaults` — the SAME gate `list_vaults`
 * uses (THE-924): only `ctx.vaultId` for a `vaultBound` caller, every configured id otherwise — and
 * `details.did_you_mean` when a case-folded or slugified form of the SUBMITTED value equals a
 * visible id. Returns `error` unchanged for every other error code, or when no visibility resolver
 * is wired (unit tests that omit it) — a strict no-op, not a degraded hint.
 */
export function vaultFailureHint(
  error: ObsidianTcError,
  def: ToolDefinition | undefined,
  rawInput: unknown,
  ctx: CallerContext,
  visibleVaultIds: RegistryOptions["visibleVaultIds"],
): ObsidianTcError {
  if (!visibleVaultIds) return error;
  const vaultArg = def?.vaultArg ?? "vault";
  let submitted: string | undefined;
  if (error.code === "vault_not_found") {
    const v = (error.details as { vault?: unknown } | undefined)?.vault;
    submitted = typeof v === "string" ? v : undefined;
  } else if (error.code === "validation_error" && def) {
    const issues = (error.details as { issues?: unknown } | undefined)?.issues;
    const hasVaultIssue =
      Array.isArray(issues) &&
      issues.some((i) => {
        const path = (i as { path?: unknown } | null)?.path;
        return Array.isArray(path) && path.length === 1 && path[0] === vaultArg;
      });
    if (!hasVaultIssue) return error;
    submitted = vaultArgOf(def, rawInput);
  } else {
    return error;
  }
  const visible = visibleVaultIds(ctx);
  const didYouMean =
    submitted !== undefined
      ? visible.find(
          (id) => id === submitted?.toLowerCase() || id === slugifyForHint(submitted ?? ""),
        )
      : undefined;
  return new ObsidianTcError(error.code, error.message, {
    ...error.details,
    visible_vaults: visible,
    ...(didYouMean ? { did_you_mean: didYouMean } : {}),
    ...(error.code === "validation_error" ? { vault_hint_path: vaultArg } : {}),
  });
}
