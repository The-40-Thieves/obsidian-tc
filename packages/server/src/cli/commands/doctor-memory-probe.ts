// `doctor --probe` input for memory.read-acl (doctor/memory-read-acl.ts). Its own file because
// doctor-probes.ts sits at the comment-style ratchet's threshold.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tableExists } from "../../db/introspect";
import { openDatabase } from "../../db/open";

/** The `memory.read-acl` probe behind `doctor --probe`: every memory entity's (vault, type, name),
 *  so the check can place each one's projection note against the read ACL. Never throws: no or
 *  unreadable cache.db reports no entities rather than a false finding. */
export async function probeMemoryEntities(
  cacheDir: string,
  busyTimeoutMs: number,
): Promise<{ vaultId: string; entityType: string; name: string }[]> {
  const path = join(cacheDir, "cache.db");
  if (!existsSync(path)) return [];
  let db: Awaited<ReturnType<typeof openDatabase>> | undefined;
  try {
    db = await openDatabase(path, busyTimeoutMs, { readonly: true });
    if (!tableExists(db, "memory_entities")) return [];
    const rows = db.prepare("SELECT vault_id, entity_type, name FROM memory_entities").all() as {
      vault_id: string;
      entity_type: string;
      name: string;
    }[];
    return rows.map((r) => ({ vaultId: r.vault_id, entityType: r.entity_type, name: r.name }));
  } catch {
    return [];
  } finally {
    try {
      db?.close?.();
    } catch {
      /* see probeNotesFts */
    }
  }
}
