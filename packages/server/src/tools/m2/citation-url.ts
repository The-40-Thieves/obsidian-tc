// Citation identity for the standard `search` / `fetch` tools: the opaque note id a result carries
// and the absolute url a client renders as a citation.
//
// The id is `<vault id>:<vault-relative path>`. A vault id is a lowercase slug (`VaultId`), so the
// FIRST colon always ends it; the path may itself contain colons. The id is not a capability: fetch
// re-runs every gate (vault binding, the named vault's ACL, the path ACL) on the vault and path it
// names, exactly as read_note does for the same two arguments.
//
// The url is `<vaults[].publicUrl>/<path>` when the vault configures a public base, else the
// obsidian://open deep link. Either way every variable part is percent-encoded with
// encodeURIComponent, so a note name can never add a query, a fragment, a path segment or a scheme.
import { VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { buildObsidianUri } from "../m6/uri-tools";

export interface NoteRef {
  vault: string;
  path: string;
}

export function noteId(vault: string, path: string): string {
  return `${vault}:${path}`;
}

/** Split a note id into vault and path, or return why it is not one. Pure syntax: no filesystem. */
export function parseNoteId(id: string): NoteRef | { error: string } {
  const colon = id.indexOf(":");
  if (colon < 1)
    return { error: 'expected "<vault id>:<note path>", the id a search result carries' };
  const vault = VaultId.safeParse(id.slice(0, colon));
  if (!vault.success) return { error: "the part before the first colon is not a vault id" };
  const path = VaultPath.safeParse(id.slice(colon + 1));
  if (!path.success) return { error: path.error.issues[0]?.message ?? "invalid note path" };
  return { vault: vault.data, path: path.data };
}

/** The citation url for a note. `vault.name` is Obsidian's display name for the vault, which is
 *  what `obsidian://open?vault=` expects (it defaults to the vault id). */
export function citationUrl(
  vault: { id: string; name: string; publicUrl?: string },
  path: string,
): string {
  if (vault.publicUrl === undefined) return buildObsidianUri("open", { file: path }, vault.name);
  const base = vault.publicUrl.replace(/\/+$/, "");
  const segments = path
    .replace(/\.md$/i, "")
    .split("/")
    .filter((s) => s !== "")
    .map(encodeURIComponent);
  return `${base}/${segments.join("/")}`;
}
