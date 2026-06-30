import type { ListResourcesResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { err, grantsAll } from "@the-40-thieves/obsidian-tc-shared";
import { enforcePathAcl } from "../vault/acl-path";
import { readableRel } from "../vault/acl-read-filter";
import { readNote } from "../vault/notes-io";
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
  return `${RESOURCE_SCHEME}://${vaultId}/${relPath}`;
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
  return { vaultId: rest.slice(0, slash), relPath: decodeURIComponent(rest.slice(slash + 1)) };
}

function canReadNotes(ctx: CallerContext): boolean {
  return grantsAll(ctx.grantedScopes, ["read:notes"]);
}

/**
 * resources/list — every readable markdown note in the caller's bound vault, as an MCP
 * resource. Mirrors list_notes: the same vault walk, filtered by the same read-ACL. Returns
 * an empty list when the caller lacks the read:notes scope.
 */
export function listResources(
  vaultRegistry: VaultRegistry,
  ctx: CallerContext,
): ListResourcesResult {
  if (!canReadNotes(ctx)) return { resources: [] };
  const v = vaultRegistry.resolve(ctx.vaultId);
  const resources = walkVault(v.root, { extensions: [".md"] })
    .filter((e) => readableRel(ctx.acl, e.relPath))
    .map((e) => ({
      uri: buildResourceUri(v.id, e.relPath),
      name: e.relPath,
      mimeType: MIME_MARKDOWN,
    }));
  return { resources };
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
  const v = vaultRegistry.resolve(vaultId);
  const rel = normalizeVaultPath(relPath);
  enforcePathAcl(ctx.acl, "read", rel);
  const abs = resolveVaultPath(v.root, rel);
  const { raw } = readNote(abs);
  if (Buffer.byteLength(raw, "utf8") > MAX_RESOURCE_BYTES)
    throw err.invalidInput(
      `resource exceeds ${MAX_RESOURCE_BYTES} bytes; read it with the read_note tool instead`,
      { uri },
    );
  return { contents: [{ uri, mimeType: MIME_MARKDOWN, text: raw }] };
}
