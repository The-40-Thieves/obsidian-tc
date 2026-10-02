// Reload of the index exclusion list when a vault's `.obsidian/app.json` changes (the vault watcher
// reports the change, vault/watcher.ts). The list itself is always read fresh by
// search/index-exclusion.ts; what this adds is the TRANSITION: when the effective list moved, the
// vault is reconciled so notes that became excluded are de-indexed and notes that stopped being
// excluded are indexed. indexVault already does both (a content-hash-skipping, incremental pass), so
// this is a trigger, not a second implementation.
import {
  type ExclusionVaultLookup,
  sameExclusion,
  type VaultExclusion,
  vaultExclusionFor,
} from "../search/index-exclusion";
import type { GatedReconcile } from "./vault-lock";

export interface ExclusionReloader {
  /** Pass to the watcher's onVaultConfigChange. Resolves once any triggered reconcile finished. */
  onVaultConfigChange: (vaultId: string) => Promise<void>;
  /** Hand over the leader-gated reconcile runner, which is built after the watcher. */
  setRunner: (run: GatedReconcile) => void;
}

export function createExclusionReloader(
  registry: ExclusionVaultLookup & { list(): Array<{ id: string }> },
  signal: AbortSignal,
  write: (message: string) => void = (m) => process.stderr.write(m),
): ExclusionReloader {
  const last = new Map<string, VaultExclusion>();
  for (const v of registry.list()) last.set(v.id, vaultExclusionFor(registry, v.id));
  let runner: GatedReconcile | undefined;
  return {
    setRunner: (run) => {
      runner = run;
    },
    onVaultConfigChange: async (vaultId) => {
      let next: VaultExclusion;
      try {
        next = vaultExclusionFor(registry, vaultId);
      } catch {
        return; // vault unknown or its root unavailable: nothing to compare against
      }
      const before = last.get(vaultId);
      last.set(vaultId, next);
      if (before !== undefined && sameExclusion(before, next)) return;
      if (!runner) return;
      const n = next.effective.length;
      write(
        `[index] vault "${vaultId}": Excluded files list changed (${n} entr${n === 1 ? "y" : "ies"}); ` +
          "reconciling the index\n",
      );
      try {
        // A pass already running started with the OLD list; let it finish, then run once more.
        await runner.currentRun()?.catch(() => undefined);
        await runner(signal);
      } catch (e) {
        write(
          `[index] vault "${vaultId}": reconcile after an Excluded files change failed: ` +
            `${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
    },
  };
}
