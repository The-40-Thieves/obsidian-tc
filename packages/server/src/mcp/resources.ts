import type { ListResourcesResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { err, grantsAll } from "@the-40-thieves/obsidian-tc-shared";
import { enforcePathAcl } from "../vault/acl-path";
import { readableRel } from "../vault/acl-read-filter";
import { readNote, statNote } from "../vault/notes-io";
import { normalizeVaultPath, resolveVaultPath, walkVault } from "../vault/paths";
import type { VaultRegistry } from "../vault/registry";
import { assertScopesGranted, type CallerContext } from "./registry";

/** Resource URI scheme. Deliberately distinct from the Obsidian app's `obsidian://` deep links. */
export const RESOURCE_SCHEME = "obsidian-tc";
const MIME_MARKDOWN = "text/markdown";

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

function canReadNotes(ctx: CallerContext): boolean {
  return grantsAll(ctx.grantedScopes, ["read:notes"]);
}

// resources/list returns at most this many notes per page; the client follows nextCursor for
// the rest. Bounds the response on a large vault, since resources bypass the dispatch governor.
const RESOURCE_PAGE_SIZE = 500;

/**
 * resources/list — readable markdown notes in the caller's bound vault, as MCP resources, one
 * page (RESOURCE_PAGE_SIZE) at a time. Mirrors list_notes: the same vault walk, filtered by the
 * same read-ACL. Returns an empty list when the caller lacks the read:notes scope. `cursor` is
 * the opaque offset carried over from a prior result's nextCursor.
 */
export function listResources(
  vaultRegistry: VaultRegistry,
  ctx: CallerContext,
  cursor?: string,
  pageSize = RESOURCE_PAGE_SIZE,
): ListResourcesResult {
  if (!canReadNotes(ctx)) return { resources: [] };
  const v = vaultRegistry.resolve(ctx.vaultId);
  const rels = walkVault(v.root, { extensions: [".md"] })
    .map((e) => e.relPath)
    .filter((rel) => readableRel(ctx.acl, rel));
  // Offset cursor over the sorted walk (walkVault sorts by relPath, so paging is stable).
  const start = cursor ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0;
  const page = rels.slice(start, start + pageSize);
  const resources = page.map((rel) => ({
    uri: buildResourceUri(v.id, rel),
    name: rel,
    mimeType: MIME_MARKDOWN,
  }));
  const nextStart = start + page.length;
  return nextStart < rels.length ? { resources, nextCursor: String(nextStart) } : { resources };
}

/**
 * resources/read — read one note's raw markdown. Enforces the read:notes scope, the folder
 * read-ACL, path containment, AND the P1.4 per-path rule-scopes (the same gates read_note applies —
 * this is the same content read on the same path, so it must honor an operator's rule-scope fence),
 * then a size ceiling.
 *
 * `maxResourceBytes` (THE-514 item 2): REQUIRED, deliberately — the caller passes the registry's
 * actual configured `maxResponseBytes` here (see mcp/server.ts) so a lowered ceiling applies to
 * resources too, not just tools. An optional parameter defaulting to some fixed literal would
 * silently recreate the exact bug this fixes: a caller that forgets to pass it gets an
 * unconfigured ceiling with no compile-time signal that config was ignored. There is exactly one
 * production call site (mcp/server.ts) and it always has a registry in scope, so there is no
 * legitimate caller this default would have served.
 */
export function readResource(
  vaultRegistry: VaultRegistry,
  ctx: CallerContext,
  uri: string,
  maxResourceBytes: number,
): ReadResourceResult {
  assertScopesGranted(ctx, ["read:notes"], "missing required scope: read:notes");
  const { vaultId, relPath } = parseResourceUri(uri);
  // Bind the read to the caller's own vault. ctx.acl is the caller's ACL for ctx.vaultId, so
  // resolving any other vault from the URI would apply the wrong ACL and leak a vault the
  // caller holds no token for. listResources only ever emits ctx.vaultId URIs; enforce it here.
  //
  // THE-514 item 2: this check is UNCONDITIONAL — unlike the tool-dispatch equivalent
  // (mcp/registry.ts, `if (ctx.vaultBound === true)` in the vault-binding guard), it fires for
  // every caller including a trusted stdio one. See the AUTHORITATIVE NOTE at that guard for why
  // the two are deliberately different rather than merely inconsistent.
  if (vaultId !== ctx.vaultId)
    throw err.forbidden(`resource vault is not the caller's bound vault: ${vaultId}`, {
      uri,
      vaultId,
    });
  const v = vaultRegistry.resolve(vaultId);
  const rel = normalizeVaultPath(relPath);
  // P1.4: pass the caller's granted scopes so a path's rule-scopes gate this direct content read
  // too — otherwise resources/read would be a bypass of the read_note path-scope gate for the
  // identical bytes. (readResource is not a runDispatch tool, so the central stage never covers it.)
  enforcePathAcl(ctx.acl, "read", rel, v.root, ctx.grantedScopes);
  const abs = resolveVaultPath(v.root, rel);
  // Stat before reading: readNote loads the whole file into memory, so enforcing the ceiling
  // only after the read would let any read:notes caller point at a multi-hundred-MB file and
  // force the full allocation just to be told it is too big. A null stat (missing file) falls
  // through to readNote, which throws the same not-found error as before.
  const stat = statNote(abs);
  if (stat !== null && stat.size > maxResourceBytes)
    throw err.invalidInput(
      `resource exceeds ${maxResourceBytes} bytes; read it with the read_note tool instead`,
      { uri },
    );
  const { raw } = readNote(abs);
  return { contents: [{ uri, mimeType: MIME_MARKDOWN, text: raw }] };
}
