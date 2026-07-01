import type { ListResourcesResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { err, grantsAll } from "@the-40-thieves/obsidian-tc-shared";
import { enforcePathAcl } from "../vault/acl-path";
import { readableRel } from "../vault/acl-read-filter";
import { readNote, statNote } from "../vault/notes-io";
import { normalizeVaultPath, resolveVaultPath, walkVault } from "../vault/paths";
import type { VaultRegistry } from "../vault/registry";
import type { CallerContext } from "./registry";

/** Resource URI scheme. Deliberately distinct from the Obsidian app's `obsidian://` deep links. */
export const RESOURCE_SCHEME = "obsidian-tc";
const MIME_MARKDOWN = "text/markdown";
// A single resource larger than this is rejected (use the read_note tool with a range), so
// resources cannot bypass the dispatch governor's response ceiling.
const MAX_RESOURCE_BYTES = 1_000_000;

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
 * read-ACL, and path containment (the same gates read_note applies), then a size ceiling.
 */
export function readResource(
  vaultRegistry: VaultRegistry,
  ctx: CallerContext,
  uri: string,
): ReadResourceResult {
  if (!canReadNotes(ctx)) throw err.forbidden("missing required scope: read:notes", { uri });
  const { vaultId, relPath } = parseResourceUri(uri);
  // Bind the read to the caller's own vault. ctx.acl is the caller's ACL for ctx.vaultId, so
  // resolving any other vault from the URI would apply the wrong ACL and leak a vault the
  // caller holds no token for. listResources only ever emits ctx.vaultId URIs; enforce it here.
  if (vaultId !== ctx.vaultId)
    throw err.forbidden(`resource vault is not the caller's bound vault: ${vaultId}`, {
      uri,
      vaultId,
    });
  const v = vaultRegistry.resolve(vaultId);
  const rel = normalizeVaultPath(relPath);
  enforcePathAcl(ctx.acl, "read", rel, v.root);
  const abs = resolveVaultPath(v.root, rel);
  // Stat before reading: readNote loads the whole file into memory, so enforcing the ceiling
  // only after the read would let any read:notes caller point at a multi-hundred-MB file and
  // force the full allocation just to be told it is too big. A null stat (missing file) falls
  // through to readNote, which throws the same not-found error as before.
  const stat = statNote(abs);
  if (stat !== null && stat.size > MAX_RESOURCE_BYTES)
    throw err.invalidInput(
      `resource exceeds ${MAX_RESOURCE_BYTES} bytes; read it with the read_note tool instead`,
      { uri },
    );
  const { raw } = readNote(abs);
  return { contents: [{ uri, mimeType: MIME_MARKDOWN, text: raw }] };
}
