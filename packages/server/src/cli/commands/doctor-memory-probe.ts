// `doctor --probe` input for memory.read-acl (doctor/memory-read-acl.ts). Its own file because
// doctor-probes.ts sits at the comment-style ratchet's threshold.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tableExists } from "../../db/introspect";
import { openDatabase } from "../../db/open";

/** The `memory.read-acl` probe behind `doctor --probe`: every memory entity's (vault, type, name, stored vault_path),
 *  so the check can place each one's projection note against the read ACL. Never throws: no or
 *  unreadable cache.db reports no entities rather than a false finding. */
export async function probeMemoryEntities(
  cacheDir: string,
  busyTimeoutMs: number,
): Promise<{ vaultId: string; entityType: string; name: string; vaultPath: string | null }[]> {
  const path = join(cacheDir, "cache.db");
  if (!existsSync(path)) return [];
  let db: Awaited<ReturnType<typeof openDatabase>> | undefined;
  try {
    db = await openDatabase(path, busyTimeoutMs, { readonly: true });
    if (!tableExists(db, "memory_entities")) return [];
    const rows = db
      .prepare("SELECT vault_id, entity_type, name, vault_path FROM memory_entities")
      .all() as {
      vault_id: string;
      entity_type: string;
      name: string;
      vault_path: string | null;
    }[];
    return rows.map((r) => ({
      vaultId: r.vault_id,
      entityType: r.entity_type,
      name: r.name,
      vaultPath: r.vault_path,
    }));
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
