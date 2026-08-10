// THE-804 — the one place that answers "which vault does this chunk_id belong to?".
//
// `chunk_retrievals` and `vault_object_state` carry no `vault_id` (G2.3 claims every table does;
// THE-805 corrects that). Isolation on those tables is therefore DERIVED, not stored: `chunkId()`
// hashes `[vaultId, path, index]`, so the id itself is vault-namespaced but not vault-READABLE —
// nothing can be recovered from the string. The only way back to a vault is the authored store.
//
// This lives in one module because a second copy is how the boundary drifts. `explain_answer` had
// the only implementation and derived scope correctly; the gap sweep did not re-derive it at all
// and leaked every vault's query text into every vault's gap report. Two readers of the same
// unscoped table, one careful and one not, is exactly the shape ADR-0002 warns about: "A reader
// who assumes physical separation will write a leak."
import type { Database } from "../db/types";

/**
 * Memoised `chunk_id -> path` lookup over the authored store, scoped to one vault.
 *
 * Returns `null` when the chunk does not belong to `vaultId` — which covers both "belongs to a
 * different vault" and "no longer exists" (re-chunking drops old ids). Callers deciding
 * attribution must treat `null` as **not this vault's**: a retrieval whose provenance cannot be
 * recovered must not be attributed to a vault by default.
 */
export function chunkPathResolver(
  db: Database,
  vaultId: string,
): (chunkId: string) => string | null {
  const stmt = db.prepare("SELECT path FROM chunks WHERE id = ? AND vault_id = ?");
  const cache = new Map<string, string | null>();
  return (chunkId) => {
    const hit = cache.get(chunkId);
    if (hit !== undefined) return hit;
    const row = stmt.get(chunkId, vaultId) as { path: string } | undefined;
    const path = row?.path ?? null;
    cache.set(chunkId, path);
    return path;
  };
}
