// The scheduled wiki lint: lint_wiki's engine on the maintenance scheduler's tick loop.
//
// OPT-IN (`maintenance.wikiLint.enabled`, default false) and READ-ONLY, like the tool: a tick runs
// the checks over each vault with operator-level read access (there is no caller to scope to),
// logs one summary line per vault, and stops. It never edits a note, never persists anything, and
// never gates a write. The proposals themselves are one `lint_wiki` call away; a log line is the
// timer's whole output on purpose, so an unattended job cannot grow a table nobody reads.
import type { Database } from "../db/types";
import type { Scheduler } from "../scheduler/scheduler";
import type { VaultExclusion } from "../search/index-exclusion";
import { LINT_CHECKS, type LintReport, runWikiLint } from "../tools/m7/knowledge/wiki-lint";
import { stderrOnError } from "../util/errors";

export interface WikiLintSweepDeps {
  cacheDb: Database;
  /** The experiential store, when open; without it the quality and coverage-gap checks are skipped. */
  experientialDb?: Database | undefined;
  /** Canonical vault roots. */
  vaults: readonly { id: string; root: string }[];
  exclusionFor: (vaultId: string) => VaultExclusion;
  embeddingModel: string;
  intervalMs: number;
  folder?: string | undefined;
  maxNotes: number;
  /** Per-vault summary sink. Production logs to stderr; tests capture the report. */
  onReport?: ((report: LintReport) => void) | undefined;
}

export function summarizeLintReport(report: LintReport): string {
  const kinds = Object.entries(report.summary.by_kind)
    .map(([k, n]) => `${k}=${n}`)
    .join(" ");
  const skipped = report.skipped.length
    ? ` (skipped: ${report.skipped.map((s) => s.check).join(", ")})`
    : "";
  return `[wiki-lint] ${report.vault}: ${report.summary.total} proposal(s)${kinds ? ` ${kinds}` : ""}${skipped}. Read-only; call lint_wiki for the list.\n`;
}

/** Register the sweep. The caller gates this on `maintenance.wikiLint.enabled`. */
export function registerWikiLintSweep(scheduler: Scheduler, deps: WikiLintSweepDeps): void {
  scheduler.register({
    name: "wiki-lint",
    intervalMs: deps.intervalMs,
    run: (signal) => {
      for (const v of deps.vaults) {
        // Cooperate with graceful shutdown between vaults, as the gap sweep does.
        if (signal.aborted) return;
        const report = runWikiLint(
          {
            root: v.root,
            db: deps.cacheDb,
            edb: deps.experientialDb,
            acl: undefined,
            grantedScopes: ["read:notes"],
            exclusion: deps.exclusionFor(v.id),
            embeddingModel: deps.embeddingModel,
          },
          {
            vaultId: v.id,
            folder: deps.folder,
            checks: LINT_CHECKS,
            limitPerCheck: 20,
            maxNotes: deps.maxNotes,
          },
        );
        if (deps.onReport) deps.onReport(report);
        else process.stderr.write(summarizeLintReport(report));
      }
    },
    onError: stderrOnError("wiki-lint"),
  });
}
