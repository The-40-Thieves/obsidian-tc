// The scheduled regeneration of each vault's generated wiki pages (index.md, log.md): the same
// `regenerateWikiPages` commit_wiki_page calls after a write, on a timer, so pages written by other
// tools, a sync client or a restore reach the index, and provenance rows made since the last
// commit reach the log. OPT-IN (`maintenance.wikiPages.enabled`).
//
// There is no caller to scope to, so the ACL is the vault's own and the readers assumed are the
// least privileged ones, exactly as at commit time (see tools/m7/knowledge/wiki-generated.ts): both
// paths therefore write the same bytes. A tick never throws and never touches a vault without a
// wiki folder; a hand-edited page is reported on the log line, not overwritten.
import type { VaultMemoryDefenseConfig } from "@the-40-thieves/obsidian-tc-shared";
import type { FolderAcl } from "../acl";
import type { Database } from "../db/types";
import type { Scheduler } from "../scheduler/scheduler";
import type { VaultExclusion } from "../search/index-exclusion";
import { regenerateWikiPages, type WikiGenerateResult } from "../tools/m7/knowledge/wiki-generated";
import { stderrOnError } from "../util/errors";

export interface WikiPagesSweepDeps {
  cacheDb: Database;
  vaults: readonly { id: string; root: string; wikiFolder?: string | undefined }[];
  aclFor: (vaultId: string) => FolderAcl | undefined;
  exclusionFor: (vaultId: string) => VaultExclusion;
  memoryDefenseFor?: ((vaultId: string) => VaultMemoryDefenseConfig | undefined) | undefined;
  snapshots?: { enabled: boolean; retention: number } | undefined;
  intervalMs: number;
  /** Per-vault result sink. Production logs to stderr; tests capture it. */
  onResult?: ((vaultId: string, result: WikiGenerateResult) => void) | undefined;
}

export function summarizeWikiPages(vaultId: string, r: WikiGenerateResult): string {
  const warned = r.warnings.map((w) => `${w.path} (${w.kind}: ${w.message})`).join("; ");
  return `[wiki-pages] ${vaultId}: wrote ${r.written.length} page(s)${warned ? `; not written: ${warned}` : ""}\n`;
}

/** Register the sweep. The caller gates this on `maintenance.wikiPages.enabled`. */
export function registerWikiPagesSweep(scheduler: Scheduler, deps: WikiPagesSweepDeps): void {
  scheduler.register({
    name: "wiki-pages",
    intervalMs: deps.intervalMs,
    run: async (signal) => {
      for (const v of deps.vaults) {
        if (signal.aborted) return;
        if (!v.wikiFolder) continue;
        const result = regenerateWikiPages({
          root: v.root,
          vaultId: v.id,
          wikiFolder: v.wikiFolder,
          acl: deps.aclFor(v.id),
          exclusion: deps.exclusionFor(v.id),
          db: deps.cacheDb,
          snapshots: deps.snapshots,
          memoryDefense: deps.memoryDefenseFor?.(v.id),
        });
        if (deps.onResult) deps.onResult(v.id, result);
        else if (result.written.length > 0 || result.warnings.length > 0)
          process.stderr.write(summarizeWikiPages(v.id, result));
      }
    },
    onError: stderrOnError("wiki-pages"),
  });
}
