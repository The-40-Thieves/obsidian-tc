// Shared wiring for the M3 structured-format tools (Canvas/Bases/Periodic/Attachments/Bookmarks/
// Workspaces). WP7: M3Deps lives in its own leaf module so implementation files can import it
// without pulling in index.ts's barrel — which imports every implementation file back, and
// previously made each of those a two-node import cycle through ./index.
import type { BridgeClient } from "../../bridge";
import type { VaultRegistry } from "../../vault/registry";

export interface M3Deps {
  vaultRegistry: VaultRegistry;
  /** THE-207: optional Templater bridge for periodic-note template expansion. When absent,
   *  or the companion/Templater is unavailable, creation degrades to a verbatim template copy. */
  templaterBridge?: (vaultId: string) => { client: BridgeClient; timeoutMs: number };
  /** THE-291: index-on-write hook for periodic-note writes (best-effort, backgrounded). */
  reindex?: (vaultId: string, path: string, content: string) => void;
}
