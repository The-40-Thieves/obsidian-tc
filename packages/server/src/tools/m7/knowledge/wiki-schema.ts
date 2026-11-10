// SCHEMA.md: the wiki folder's own statement of what a page is. The parse + check half lives in
// conventions/wiki-schema.ts (the conventions subsystem checks pages against the same schema and
// must not import a tool module), the layout constants in conventions/wiki-layout.ts; both are
// re-exported here so existing importers are unchanged. This module keeps the vault-READ half:
// loadWikiSchema reads `<folder>/SCHEMA.md` as an ordinary vault file under the read ACL (denied ==
// missing), never throws and never blocks a write.

import { SCHEMA_LIMITS, WIKI_SCHEMA_FILE } from "../../../conventions/wiki-layout";
import { parseWikiSchema, type WikiSchemaLoad } from "../../../conventions/wiki-schema";
import { enforcePathAcl } from "../../../vault/acl-path";
import { readableRel } from "../../../vault/acl-read-filter";
import { noteExists, readNoteBounded } from "../../../vault/notes-io";
import { resolveVaultPath } from "../../../vault/paths";
import { readFailureReason } from "../../../vault/read-failure";
import type { ScanScope } from "../../wiki-scan";

export { SCHEMA_LIMITS, WIKI_SCHEMA_FILE, WIKI_TYPE_KEY } from "../../../conventions/wiki-layout";
export type {
  SchemaProblem,
  WikiPageType,
  WikiSchema,
  WikiSchemaLoad,
} from "../../../conventions/wiki-schema";
export { checkFrontmatter, parseWikiSchema } from "../../../conventions/wiki-schema";

/** Read and parse `<folder>/SCHEMA.md`. A missing or unreadable file is `found: false`, not an error. */
export function loadWikiSchema(scope: ScanScope, folder: string | undefined): WikiSchemaLoad {
  const path = folder ? `${folder}/${WIKI_SCHEMA_FILE}` : WIKI_SCHEMA_FILE;
  if (!folder || !readableRel(scope.acl, path, scope.grantedScopes))
    return { path, found: false, schema: null, warnings: [] };
  // The read ACL is enforced on the REAL path, not just the name: SCHEMA.md may be a symlink to a
  // note the caller cannot read. Denied (or a link out of the vault) == missing.
  try {
    enforcePathAcl(scope.acl, "read", path, scope.root, scope.grantedScopes);
  } catch {
    return { path, found: false, schema: null, warnings: [] };
  }
  try {
    const abs = resolveVaultPath(scope.root, path);
    if (noteExists(abs).type !== "file") return { path, found: false, schema: null, warnings: [] };
    // Read with a ceiling, not stat-then-read: a file that grows after a size check is still cut off.
    const { raw } = readNoteBounded(abs, SCHEMA_LIMITS.fileBytes);
    if (raw === null)
      return {
        path,
        found: true,
        schema: null,
        warnings: [`${path} was not read: it is larger than ${SCHEMA_LIMITS.fileBytes} bytes`],
      };
    return parseWikiSchema(raw, path);
  } catch (e) {
    return {
      path,
      found: true,
      schema: null,
      warnings: [`${path} could not be read: ${readFailureReason(e)}`],
    };
  }
}
