// Shared wiring for the M1 vault-CRUD/metadata tools (WP7: M1Deps lives in its own leaf
// module so implementation files can import it without pulling in index.ts's barrel — which
// imports every implementation file back, and previously made each of those a two-node
// import cycle through ./index).
import type { ResponseFormat, VaultMemoryDefenseConfig } from "@the-40-thieves/obsidian-tc-shared";
import type { Database } from "../../db/types";
import type { PagingDeps } from "../../mcp/byte-page";
import type { MetricsRecorder } from "../../metrics/registry";
import type { KeyResolver } from "../../provenance/signer";
import type { ProvenanceStamper } from "../../provenance/stamp";
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
  /** GH #1027: `tools.defaults.responseFormat`, the format a call that names neither `response_format`
   *  nor the legacy `verbosity` alias gets. Absent -> "detailed" (the shipped default). */
  responseFormat?: ResponseFormat;
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
  /** GH #994 follow-up: per-vault memoryDefense policy for write_note/append_note/patch_note.
   *  Absent -> MEMORY_DEFENSE_OFF (mode "off", no scan), same "closure, defaulted at the read
   *  site" shape M5/M8 already use. */
  memoryDefense?: (vaultId: string) => VaultMemoryDefenseConfig;
  /** GH #994 follow-up: memoryDefense's obsidian_tc_memory_defense_hits_total counter. */
  metrics?: MetricsRecorder;
  /** Continuation-cursor signing codec + live byte budget for bulk reads (mcp/byte-page.ts). Absent
   *  (tests, bare registries) -> a per-process random key and the registry's 1 MB default budget. */
  paging?: PagingDeps;
  /** Optional provenance stamps (`provenance.stamp.*`, off by default): a newly created note gets a
   *  compact provenance key. Absent -> nothing is stamped, outputs byte-identical. */
  provenanceStamp?: ProvenanceStamper;
  /** get_provenance's include_verification: the auth registry's public keys (every state), read
   *  per call because the registry opens after the tools register. Absent or returning undefined
   *  (no registry: stdio-only) -> a signed record reports `unverifiable`, never `valid`. */
  provenanceKeys?: () => KeyResolver | undefined;
}
