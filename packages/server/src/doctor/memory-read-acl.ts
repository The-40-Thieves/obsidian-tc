// memory.read-acl — would the folder read ACL hide existing memory entities from get_entity and
// query_entity_graph? Those tools follow the same read ACL as read_note, evaluated on the entity's
// projection note (<memoryFolder>/<type>/<name>.md), so a restrictive `readPaths` (or
// `strictReadDefault` with no `readPaths`) that omits the memory folder makes every entity under it
// read as "not found" — a silent change for an operator whose agents used to read memory freely.
//
// Own module, same reasoning as capture-location.ts: a self-contained classifier over an
// already-resolved view. Entity rows come from a probe (cache.db), so the default run stays offline.
import type { FolderAcl } from "../acl";
import { entityNotePath } from "../memory/materialize";
import { readableByFolder } from "../vault/acl-read-filter";
import type { Check, CheckResult, CheckStatus } from "./types";

export interface MemoryReadAclView {
  vaults: readonly { id: string; memoryFolder: string; acl: FolderAcl | undefined }[];
  /** Probe-only: every memory entity, so the check reasons about the real note paths. Absent ->
   *  reported as "not probed" rather than a false "ok". */
  probe?: () => readonly {
    vaultId: string;
    entityType: string;
    name: string;
    /** The stored `vault_path`, when probed: an old location is read-gated too (memoryReadable). */
    vaultPath?: string | null;
  }[];
}

/**
 * memory.read-acl — WARNING, never FAIL: nothing is broken, entities are hidden by policy. The
 * check mirrors `memoryReadable` (tools/m5/memory-projection.ts) for everything that does not depend
 * on WHO is asking: the computed note path AND a differing stored `vault_path` must both pass, and a
 * path that cannot be computed (a `..` segment) fails closed. The one difference is deliberate: it
 * uses `readableByFolder`, so a rule-scope a particular caller lacks (a per-caller property doctor
 * cannot see) is not counted. Output is operator-only (stdout of `doctor`), never a tool result.
 */
export function memoryReadAclCheck(view: MemoryReadAclView): Check {
  return {
    id: "memory.read-acl",
    category: "security",
    run: (): CheckResult => {
      if (!view.probe) {
        return {
          status: "ok" as CheckStatus,
          summary: "memory read ACL (not probed): run `doctor --probe` to read memory_entities",
          details: { memory: "not probed" },
        };
      }
      const entities = view.probe();
      const issues: string[] = [];
      const folders: string[] = [];
      for (const v of view.vaults) {
        const mine = entities.filter((e) => e.vaultId === v.id);
        const hidden = mine.filter((e) => {
          try {
            const paths = [entityNotePath(v.memoryFolder, e.entityType, e.name)];
            if (e.vaultPath != null && e.vaultPath !== paths[0]) paths.push(e.vaultPath);
            return !paths.every((rel) => readableByFolder(v.acl, rel));
          } catch {
            return true;
          }
        });
        if (hidden.length === 0) continue;
        folders.push(`${v.memoryFolder.replace(/\/+$/, "")}/**`);
        issues.push(
          `vault ${v.id}: ${hidden.length} of ${mine.length} memory entities are hidden from get_entity/query_entity_graph by acl.readPaths / acl.strictReadDefault (their notes under ${v.memoryFolder}/ are not readable)`,
        );
      }
      if (issues.length === 0) {
        return {
          status: "ok" as CheckStatus,
          summary: "every memory entity's note is readable under the read ACL",
          details: { entities: String(entities.length) },
        };
      }
      const globs = [...new Set(folders)].map((f) => `"${f}"`).join(", ");
      return {
        status: "warning" as CheckStatus,
        summary: `the read ACL hides memory entities in ${issues.length} vault(s)`,
        issues,
        remediation: `Memory reads follow the folder read ACL on each entity's note. Add ${globs} to readPaths if agents should read memory, or leave it as is to keep those entities private.`,
      };
    },
  };
}
