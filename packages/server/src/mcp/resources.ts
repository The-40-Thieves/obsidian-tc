import type { ListResourcesResult, ReadResourceResult } from "@modelcontextprotocol/server";
import { err, grantsAll, ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import type { FolderAcl } from "../acl";
import { type ResponseFormat, resolveResponseFormat } from "../tools/response-format";
import { enforcePathAcl } from "../vault/acl-path";
import { readableEntry } from "../vault/acl-read-filter";
import { splitFrontmatterBody } from "../vault/frontmatter";
import { noteExists, readNote, statNote } from "../vault/notes-io";
import { normalizeVaultPath, resolveVaultPath, walkVault } from "../vault/paths";
import type { VaultRegistry } from "../vault/registry";
import { profileHiddenTools } from "./capability-hidden";
import { buildCatalog, renderCatalogResource } from "./facade";
import { assertScopesGranted, type CallerContext, type ToolRegistry } from "./registry";
import { withInternalReason } from "./resource-errors";
import type { VisibilityCaller } from "./visibility";

/** Resource URI scheme. Deliberately distinct from the Obsidian app's `obsidian://` deep links. */
export const RESOURCE_SCHEME = "obsidian-tc";
const MIME_MARKDOWN = "text/markdown";
const MIME_JSON = "application/json";

// THE-937: the tool catalog resource. Not a vault URI — `<scheme>://catalog`, with no vault
// segment — so it is matched by identity BEFORE parseResourceUri (which requires a
// `<vault>/<path>` shape and would reject this as malformed).
export const CATALOG_RESOURCE_URI = `${RESOURCE_SCHEME}://catalog`;

/** The `resources/list` row advertising the catalog resource. Listed first (mcp/server.ts), ahead
 *  of the paginated vault notes — one row, no pagination cost. */
export function catalogResourceEntry(): {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
} {
  return {
    uri: CATALOG_RESOURCE_URI,
    name: "Tool catalog",
    description:
      "Every capability visible to this caller, grouped by domain (name + one-line summary, no schemas). See also find_capability for a query-driven search over the same catalog.",
    mimeType: MIME_JSON,
  };
}

/**
 * resources/read for the catalog URI: the caller-visible catalog (buildCatalog, THE-937) as
 * `{domain, name, summary}[]` JSON. Filtered exactly the way find_capability is (mcp/server.ts
 * passes the same `registry.listVisible(...)` result in), so a caller never sees a name it could
 * not call. The one-hour `ttlMs` / `cacheScope: private` cache hint is applied by the caller
 * (mcp/server.ts), which knows the URI and can set it only for this resource, not every read.
 *
 * `dispatchResource`'s `requiredScopes` parameter (mcp/server.ts) is audit/rate-limit metadata
 * ONLY — resources.ts owns AUTHORIZATION for every resource, same as readResource below — so this
 * asserts the scope itself rather than trusting the caller to have gated it.
 *
 * `maxResourceBytes` threads the registry's configured ceiling the same way readResource's does
 * (THE-514 item 2) — a lowered ceiling applies to the catalog too, not just vault notes. There is
 * no cheap pre-check here (no stat to read before building, unlike a vault file): the caller-visible
 * catalog is already bounded by the registered tool count, so building it first and checking the
 * serialized size is cheap in practice, not the multi-hundred-MB risk readResource's stat guards.
 */
export function readCatalogResource(
  ctx: CallerContext,
  registry: ToolRegistry,
  caller: VisibilityCaller,
  maxResourceBytes: number,
): ReadResourceResult {
  assertScopesGranted(ctx, ["read:notes"], "missing required scope: read:notes");
  const entries = renderCatalogResource(buildCatalog(registry.listVisible(caller)));
  // THE-1131: how many registered tools `toolFacade.profile: "core"` hides from `entries` above,
  // so the catalog says so rather than reading as the complete surface. 0 under "full" (nothing
  // hidden) omits the field entirely.
  const hiddenByProfileCount = profileHiddenTools(
    registry.list(),
    registry.visibilityConfig(),
    caller,
  ).length;
  const text = JSON.stringify({
    tools: entries,
    ...(hiddenByProfileCount > 0
      ? {
          hiddenByProfile: {
            count: hiddenByProfileCount,
            note: `${hiddenByProfileCount} more tool(s) exist but are hidden by toolFacade.profile: "core"; set toolFacade.profile: "full" to see them, or call describe_capability/call_capability by name.`,
          },
        }
      : {}),
  });
  if (Buffer.byteLength(text, "utf8") > maxResourceBytes)
    throw err.invalidInput(`resource exceeds ${maxResourceBytes} bytes`, {
      uri: CATALOG_RESOURCE_URI,
    });
  return {
    contents: [{ uri: CATALOG_RESOURCE_URI, mimeType: MIME_JSON, text }],
  };
}

export function buildResourceUri(vaultId: string, relPath: string): string {
  // Percent-encode each path segment so names containing %, spaces, #, or ? round-trip through
  // parseResourceUri's decodeURIComponent. Encoding per segment keeps the "/" separators literal
  // (a single filesystem path segment never contains a "/").
  const encodedPath = relPath.split("/").map(encodeURIComponent).join("/");
  return `${RESOURCE_SCHEME}://${vaultId}/${encodedPath}`;
}

/** Parse an `obsidian-tc://<vault>/<path>` resource URI. Throws on a foreign or malformed URI. */
export function parseResourceUri(uri: string): { vaultId: string; relPath: string } {
  const prefix = `${RESOURCE_SCHEME}://`;
  if (!uri.startsWith(prefix))
    throw err.invalidInput(`unsupported resource URI scheme: ${uri}`, { uri });
  const rest = uri.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash <= 0)
    throw err.invalidInput(
      `malformed resource URI (expected ${RESOURCE_SCHEME}://<vault>/<path>): ${uri}`,
      { uri },
    );
  let relPath: string;
  try {
    relPath = decodeURIComponent(rest.slice(slash + 1));
  } catch {
    // A client-supplied URI with a malformed percent-escape (e.g. a literal `50% done.md`)
    // must yield a clean invalid-input error, not an unhandled URIError that crashes the handler.
    throw err.invalidInput(`malformed resource URI (invalid percent-encoding): ${uri}`, { uri });
  }
  return { vaultId: rest.slice(0, slash), relPath };
}

// THE-937: exported so mcp/server.ts's resources/list handler can gate the catalog row by the same
// check listResources applies to notes below — without it, a caller lacking read:notes would see
// the catalog resource ADVERTISED (though still refused on resources/read, which asserts the scope
// itself) while every note is correctly absent.
export function canReadNotes(ctx: CallerContext): boolean {
  return grantsAll(ctx.grantedScopes, ["read:notes"]);
}

/**
 * Resolves the ACL that governs a vault — `ToolRegistry.aclFor`, i.e. the SAME per-vault resolver
 * tool dispatch swaps in for a tool that names a vault. `undefined` = no override wired, so the
 * caller's own `ctx.acl` (the root default) governs, exactly as dispatch falls back.
 */
export type VaultAclResolver = (vaultId: string) => FolderAcl | undefined;

/** The ACL the resource surfaces enforce for `vaultId`. A resource URI names its vault inside the
 *  URI, not in a `vault` argument, so dispatch's applyVaultAcl swap never runs for these surfaces;
 *  without this they were authorized by the ROOT ACL against a vault whose own override was
 *  narrower. Required (no default) on purpose, like `maxResourceBytes`: a caller that forgets it
 *  must fail to compile, not silently fall back to the root ACL. */
function aclOfVault(ctx: CallerContext, vaultId: string, aclFor: VaultAclResolver) {
  return aclFor(vaultId) ?? ctx.acl;
}

// resources/list returns at most this many notes per page; the client follows nextCursor for
// the rest. Bounds the response on a large vault, since resources bypass the dispatch governor.
const RESOURCE_PAGE_SIZE = 500;

/**
 * Whether this caller may be served notes from a vault other than its own. A vault-bound caller (an
 * HTTP token, `vaultBound: true`) never is, because its tools are pinned to its vault too
 * (registry/input-binding.ts). Nor is any caller when `resources.boundVaultOnly` is set.
 */
function servesForeignVaults(ctx: CallerContext, vaultRegistry: VaultRegistry): boolean {
  return ctx.vaultBound !== true && !vaultRegistry.boundVaultOnly;
}

/**
 * resources/list — readable markdown notes as MCP resources, one page (RESOURCE_PAGE_SIZE) at a
 * time. A trusted, unbound caller lists every registered vault it may read; a vault-bound caller
 * and `boundVaultOnly` list the caller's own vault alone. Each vault is walked under its OWN ACL
 * (`aclFor`), and the read-ACL filters the walk before the page is cut, so no page is short of or
 * padded with notes the caller cannot read. Mirrors list_notes, except that a hard-linked note (which
 * every read refuses) is left out; list_notes still lists it. Returns an empty list when the
 * caller lacks the read:notes scope. `cursor` is the opaque offset carried over from a prior
 * result's nextCursor, into the caller's whole filtered list.
 */
export function listResources(
  vaultRegistry: VaultRegistry,
  ctx: CallerContext,
  aclFor: VaultAclResolver,
  cursor?: string,
  pageSize = RESOURCE_PAGE_SIZE,
): ListResourcesResult {
  if (!canReadNotes(ctx)) return { resources: [] };
  const vaults = servesForeignVaults(ctx, vaultRegistry)
    ? vaultRegistry.list()
    : [vaultRegistry.resolve(ctx.vaultId)];
  const notes = vaults.flatMap((v) => {
    const acl = aclOfVault(ctx, v.id, aclFor);
    // A hard-linked note is refused by every read (readNote, the acl-path guard), so it is left out
    // here, before the page is cut, rather than taking a slot in a page the caller cannot read.
    return walkVault(v.root, { extensions: [".md"] })
      .filter((e) => !e.hardLinked && readableEntry(acl, e, ctx.grantedScopes))
      .map((e) => ({ vaultId: v.id, relPath: e.relPath }));
  });
  // Offset cursor over the filtered walk: walkVault sorts each vault by relPath and vaults keep
  // their registration order, so paging is stable.
  const start = cursor ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0;
  const page = notes.slice(start, start + pageSize);
  const resources = page.map((n) => ({
    uri: buildResourceUri(n.vaultId, n.relPath),
    name: n.relPath,
    mimeType: MIME_MARKDOWN,
  }));
  const nextStart = start + page.length;
  return nextStart < notes.length ? { resources, nextCursor: String(nextStart) } : { resources };
}

/**
 * Runs a lookup in a FOREIGN vault and answers any domain refusal it raises as a missing note. An
 * unknown vault, a denied folder or path, a link escape and a hard link then all carry the same
 * error, so the URI cannot be used to learn which vaults or notes exist. An unexpected failure
 * (`internal`, or not a domain error at all) is rethrown.
 */
function answeringAsMissing<T>(uri: string, locate: () => T): T {
  try {
    return locate();
  } catch (e) {
    if (e instanceof ObsidianTcError && e.code !== "internal") {
      // The caller learns nothing; the audit gets the true reason (an unknown vault is
      // vault_not_found), and read_resources still counts every such item as a denial.
      throw withInternalReason(err.noteNotFound("note not found", { uri }), e.code);
    }
    throw e;
  }
}

/**
 * The note's absolute path and stat, once the caller may read it: the vault's root and folder ACL
 * (plus the path's rule-scopes), then existence. A folder answers like a missing note (read_note's
 * rule), and so does a path with no stat.
 */
function locateNote(
  vaultRegistry: VaultRegistry,
  ctx: CallerContext,
  vaultId: string,
  relPath: string,
  aclFor: VaultAclResolver,
  uri: string,
): { abs: string; stat: NonNullable<ReturnType<typeof statNote>> } {
  const v = vaultRegistry.resolve(vaultId);
  const rel = normalizeVaultPath(relPath);
  // P1.4: the caller's granted scopes gate a path's rule-scopes here too. readResource is not a
  // runDispatch tool, so the central stage never covers this direct content read.
  enforcePathAcl(aclOfVault(ctx, vaultId, aclFor), "read", rel, v.root, ctx.grantedScopes);
  const abs = resolveVaultPath(v.root, rel);
  const stat = noteExists(abs).type === "folder" ? null : statNote(abs);
  if (stat === null) throw err.noteNotFound("note not found", { uri });
  return { abs, stat };
}

/**
 * resources/read — read one note's raw markdown, with the checks read_note applies to the same note:
 * the read:notes scope, the folder read-ACL (plus the path's P1.4 rule-scopes), path containment and
 * the hard-link refusal, then a size ceiling.
 *
 * Which vault the URI may name:
 *  - the caller's own vault (`ctx.vaultId`) is read exactly as before;
 *  - a vault-bound caller (an HTTP token, `vaultBound: true`, THE-267) gets the old refusal for any
 *    other vault, as the tools give it, and so does every caller when `boundVaultOnly` is set
 *    (`resources.boundVaultOnly`);
 *  - any other registered vault is served under that vault's OWN ACL (`aclFor`). For such a vault
 *    every refusal answers as a missing note (answeringAsMissing), so the URI cannot be used to
 *    learn which vaults or notes exist.
 *
 * `maxResourceBytes` (THE-514 item 2): REQUIRED, deliberately — the caller passes the registry's
 * configured `maxResponseBytes` (see mcp/server.ts) so a lowered ceiling applies to resources too.
 * `aclFor` and `format` are REQUIRED for the same reason: a caller that forgets one must fail to
 * compile, not silently fall back to the root ACL.
 *
 * `format` (GH #1027): "concise" returns the note body without its frontmatter block; "detailed"
 * returns the raw markdown. The size ceiling is checked against the RAW size for both.
 * read_resources calls this per item, so both surfaces share the one rule.
 */
export function readResource(
  vaultRegistry: VaultRegistry,
  ctx: CallerContext,
  uri: string,
  maxResourceBytes: number,
  aclFor: VaultAclResolver,
  format: ResponseFormat,
): ReadResourceResult {
  assertScopesGranted(ctx, ["read:notes"], "missing required scope: read:notes");
  const { vaultId, relPath } = parseResourceUri(uri);
  const foreign = vaultId !== ctx.vaultId;
  if (foreign && !servesForeignVaults(ctx, vaultRegistry))
    throw err.forbidden(`resource vault is not the caller's bound vault: ${vaultId}`, {
      uri,
      vaultId,
    });
  // Stat before reading: readNote loads the whole file into memory, so enforcing the ceiling only
  // after the read would let any read:notes caller point at a multi-hundred-MB file and force the
  // full allocation just to be told it is too big.
  // A foreign refusal answers as a missing note at every step that can refuse, the read included:
  // the native no-follow open refuses an in-vault symlink only after locate has passed.
  const onForeign = <T>(run: () => T): T => (foreign ? answeringAsMissing(uri, run) : run());
  const { abs, stat } = onForeign(() =>
    locateNote(vaultRegistry, ctx, vaultId, relPath, aclFor, uri),
  );
  if (stat.size > maxResourceBytes)
    throw err.invalidInput(
      `resource exceeds ${maxResourceBytes} bytes; read it with the read_note tool instead`,
      { uri, size: stat.size, budget: maxResourceBytes },
    );
  const { raw } = onForeign(() => readNote(abs));
  const text = format === "concise" ? splitFrontmatterBody(raw) : raw;
  return { contents: [{ uri, mimeType: MIME_MARKDOWN, text }] };
}

/**
 * The two production entry points (mcp/server.ts): readResource / listResources with the
 * registry-derived inputs every real call needs already bound — the configured response ceiling
 * and the registry's per-vault ACL resolver — so the server cannot pass one and forget the other.
 */
export function readResourceFor(
  opts: {
    registry: Pick<ToolRegistry, "maxResponseBytes" | "aclFor">;
    /** GH #1027: `tools.defaults.responseFormat`. resources/read has no parameters, so this is the
     *  only thing that can select the concise shape. */
    responseFormat?: ResponseFormat | undefined;
  },
  vaultRegistry: VaultRegistry,
  ctx: CallerContext,
  uri: string,
): ReadResourceResult {
  const { registry } = opts;
  return readResource(
    vaultRegistry,
    ctx,
    uri,
    registry.maxResponseBytes,
    (id) => registry.aclFor(id),
    resolveResponseFormat({}, opts.responseFormat),
  );
}

export function listResourcesFor(
  registry: Pick<ToolRegistry, "aclFor">,
  vaultRegistry: VaultRegistry,
  ctx: CallerContext,
  cursor?: string,
): ListResourcesResult {
  return listResources(vaultRegistry, ctx, (id) => registry.aclFor(id), cursor);
}
