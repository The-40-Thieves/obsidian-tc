// Shared wiring for the M3 structured-format tools (Canvas/Bases/Periodic/Attachments/Bookmarks/
// Workspaces). WP7: M3Deps lives in its own leaf module so implementation files can import it
// without pulling in index.ts's barrel — which imports every implementation file back, and
// previously made each of those a two-node import cycle through ./index.
import type { ResponseFormat, VaultMemoryDefenseConfig } from "@the-40-thieves/obsidian-tc-shared";
import type { BridgeClient } from "../../bridge";
import type { MetricsRecorder } from "../../metrics/registry";
import type { VaultRegistry } from "../../vault/registry";

export interface M3Deps {
  vaultRegistry: VaultRegistry;
  /** GH #1027: `tools.defaults.responseFormat`, the format a call that names neither
   *  `response_format` nor the legacy `verbosity` alias gets. Absent -> "detailed". */
  responseFormat?: ResponseFormat;
  /** THE-207: optional Templater bridge for periodic-note template expansion. When absent,
   *  or the companion/Templater is unavailable, creation degrades to a verbatim template copy. */
  templaterBridge?: (vaultId: string) => { client: BridgeClient; timeoutMs: number };
  /** THE-291: index-on-write hook for periodic-note writes (best-effort, backgrounded). */
  reindex?: (vaultId: string, path: string, content: string) => void;
  /** per-vault memoryDefense policy for periodic-note create/append/find_or_create and
   *  the GFM table mutate tool — the SAME closure/metrics M1/M5/M8 already get. Absent ->
   *  MEMORY_DEFENSE_OFF (mode "off", no scan). */
  memoryDefense?: (vaultId: string) => VaultMemoryDefenseConfig;
  metrics?: MetricsRecorder;
  /** Snapshot-on-write policy. move_attachment snapshots each referencing note it
   *  rewrites, so restore_note can undo the rewrite. Absent -> no capture. */
  snapshots?: { enabled: boolean; retention: number };
  /** `writes.maxAttachmentBytes`: decoded-byte ceiling on one write_attachment payload. Absent
   *  (tests) -> 25 MB, the config default. */
  maxAttachmentBytes?: number;
}
