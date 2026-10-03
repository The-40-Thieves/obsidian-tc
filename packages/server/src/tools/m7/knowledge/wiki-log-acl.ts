// The wiki folder's generated `log.md` carries the principal, model and tool of every change: the
// same facts get_provenance gates behind `read:provenance`. It is an ordinary note, so the gate is
// put where every other read decision already is: an implicit per-path rule-scope on that one path
// (the machinery enforcePathAcl, readableRel and callerCanReadVaultPath honour), built wherever a
// vault's ACL is built. read_note, the search tools, backlinks, resources, lint and the rest then
// deny it to a caller without the scope, with the same shape as any denied read.
import { type AclConfigT, FolderAcl } from "../../../acl";
import { WIKI_LOG_FILE } from "./wiki-folder";

/** The scope get_provenance also requires, now required to read `log.md`. */
export const WIKI_LOG_SCOPE = "read:provenance";

/** The vault's ACL config plus the implicit rule for `${wikiFolder}/log.md`. The rule is last so it
 *  applies (last match wins), and carries what an operator rule on that path already required plus
 *  the provenance scope, so an operator's own requirement is never loosened. A rule-scope gates
 *  every operation on the path, which is what keeps the log from being forged by a caller who may
 *  not read it. The folder is a plain path, used as the glob (a `*` or `?` in it can only over-match,
 *  which asks for the scope on one more path, never fewer). */
export function withWikiLogScope(cfg: AclConfigT, wikiFolder: string | undefined): AclConfigT {
  if (!wikiFolder) return cfg;
  const glob = `${wikiFolder}/${WIKI_LOG_FILE}`;
  const required = new FolderAcl(cfg).scopesForPath(glob);
  return {
    ...cfg,
    rules: [...cfg.rules, { glob, scopes: [...new Set([...required, WIKI_LOG_SCOPE])] }],
  };
}
