// The wiki folder's generated `log.md` carries the principal, model and tool of every change: the
// same facts get_provenance gates behind `read:provenance`. It is an ordinary note, so the gate is
// put where every other read decision already is: an implicit per-path rule-scope on that one path
// (the machinery enforcePathAcl, readableRel and callerCanReadVaultPath honour), built wherever a
// vault's ACL is built. read_note, the search tools, backlinks, resources, lint and the rest then
// deny it to a caller without the scope, with the same shape as any denied read.
import { type AclConfigT, escapeGlob, FolderAcl } from "../../../acl";
import { WIKI_LOG_FILE } from "./wiki-folder";

/** The scope get_provenance also requires, now required to read `log.md`. */
export const WIKI_LOG_SCOPE = "read:provenance";

/** The implicit rule for `${folder}/log.md`, one per folder given: the scope the path already
 *  requires under `cfg` plus the provenance scope. Folders are escaped before they become globs, so
 *  `*`, `?` and `[` in a real folder name stay literal and cannot scope unrelated paths. */
export function wikiLogRules(
  cfg: AclConfigT,
  folders: readonly string[],
): { glob: string; scopes: string[] }[] {
  const acl = new FolderAcl(cfg);
  return folders.map((folder) => {
    const path = folder === "" ? WIKI_LOG_FILE : `${folder}/${WIKI_LOG_FILE}`;
    return {
      glob: folder === "" ? WIKI_LOG_FILE : `${escapeGlob(folder)}/${WIKI_LOG_FILE}`,
      scopes: [...new Set([...acl.scopesForPath(path), WIKI_LOG_SCOPE])],
    };
  });
}

/** The vault's ACL config plus the implicit rule for `${wikiFolder}/log.md`, and for the same file
 *  under `canonicalFolder` when the wiki folder is a symlink (or sits under one): enforcement
 *  resolves symlinks before it matches a rule, so the real spelling needs the rule as much as the
 *  configured one. The rules are last so they apply (last match wins), and carry what an operator
 *  rule on that path already required plus the provenance scope, so an operator's own requirement is
 *  never loosened. A rule-scope gates every operation on the path, which is what keeps the log from
 *  being forged by a caller who may not read it. */
export function withWikiLogScope(
  cfg: AclConfigT,
  wikiFolder: string | undefined,
  canonicalFolder?: string,
): AclConfigT {
  if (!wikiFolder) return cfg;
  return {
    ...cfg,
    rules: [
      ...cfg.rules,
      ...wikiLogRules(cfg, [
        wikiFolder,
        ...(canonicalFolder === undefined ? [] : [canonicalFolder]),
      ]),
    ],
  };
}
