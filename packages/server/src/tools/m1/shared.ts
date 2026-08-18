// Shared wiring for the M1 vault-CRUD/metadata tools (WP7: M1Deps lives in its own leaf
// module so implementation files can import it without pulling in index.ts's barrel — which
// imports every implementation file back, and previously made each of those a two-node
// import cycle through ./index).
import type { Database } from "../../db/types";
import type { VaultRegistry } from "../../vault/registry";

export interface M1Deps {
  vaultRegistry: VaultRegistry;
  version: string;
  startedAt: number;
  embeddings: { provider: string; model: string };
  configPath?: string;
  /** Index-on-write (THE-255): a note mutation reindexes its path; a delete drops its chunks.
   *  Optional — omitted in tests, so M1 writes never touch the search index there. */
  reindex?: (vaultId: string, path: string, content: string) => void;
  deindex?: (vaultId: string, path: string) => void;
  /** THE-374: snapshot-on-write policy. When enabled, destructive writes first capture the
   *  prior note state (content-addressed) so restore_note can roll back. Absent -> no capture. */
  snapshots?: { enabled: boolean; retention: number };
  /** THE-291 (3B): metadata-index readiness. ready() flips when the boot reconcile's notes pass
   *  committed (independent of embedding success). Absent (tests) -> disk scans. */
  metadataIndex?: { hasFts: boolean; ready: () => boolean };
  /** THE-376: index a newly runtime-registered vault (add_vault). Absent in tests -> add_vault
   *  registers only; filesystem tools work immediately and search populates on next reconcile. */
  indexVault?: (vaultId: string) => Promise<{ notes_seen: number }>;
  /** THE-252: when true, write_note (overwrite) + append_note to an existing note require prev_hash. */
  requireCas?: boolean;
  /** THE-603: fires when captureSnapshot no-ops for a destructive write because
   *  config.snapshots.enabled is false — an explicit opt-out from the now-on-by-default
   *  "trusted-local" posture (THE-648) — so the caller sees the gap instead of a silently inert
   *  safety net. Same plain-callback seam as onVecFallback:
   *  the tool layer never imports the audit/metrics modules directly. Absent (tests) -> no signal. */
  onSnapshotSkipped?: (vaultId: string, path: string, op: string) => void;
  /** THE-643 item 1: open experiential.db handle, present only while experientialOpen (same gate
   *  recomputeNoteQualityAll runs under in plane-wiring.ts) — the write-time guardrail's point
   *  read into note_quality. Absent (store closed, or tests that don't need it) -> write_note/
   *  append_note/patch_note report quality_warning: null, same as "rollup never ran". */
  edb?: Database;
}
