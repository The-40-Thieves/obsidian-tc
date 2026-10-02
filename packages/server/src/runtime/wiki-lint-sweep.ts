// The scheduled wiki lint: lint_wiki's engine on the maintenance scheduler's tick loop.
//
// OPT-IN (`maintenance.wikiLint.enabled`, default false) and READ-ONLY, like the tool: a tick runs
// the checks over each vault with operator-level read access (there is no caller to scope to),
// logs one summary line per vault, and stops. It never edits a note, never persists anything, and
// never gates a write. The proposals themselves are one `lint_wiki` call away; a log line is the
// timer's whole output on purpose, so an unattended job cannot grow a table nobody reads.
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import type { Database } from "../db/types";
import { compileEgressFilter, type EgressFilter } from "../plane/egress-filter";
import type { GatewayRoles } from "../plane/gateway";
import type { Scheduler } from "../scheduler/scheduler";
import type { VaultExclusion } from "../search/index-exclusion";
import {
  createWikiJudge,
  type WikiJudgeBackend,
  type WikiJudgeSettings,
} from "../tools/m7/knowledge/wiki-judge";
import { resolveWikiJudgeBackend } from "../tools/m7/knowledge/wiki-judge-typesafe";
import { LINT_CHECKS, type LintReport, runWikiLint } from "../tools/m7/knowledge/wiki-lint";
import { judgeNearDuplicates, type PairJudgeReport } from "../tools/m7/knowledge/wiki-lint-judge";
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
  onReport?: ((report: LintReport, judge?: PairJudgeReport) => void) | undefined;
  /** (maintenance.wikiLint.judge, on by default): rule on near-duplicate pairs with the wiki judge, at
   *  most `maxCalls` judge calls per vault per run, on top of wikiJudge.maxCallsPerDay. */
  judge?:
    | {
        roles: GatewayRoles | null;
        /** Absent derives the gateway backend from `roles`; `null` is "no judge". */
        backend?: WikiJudgeBackend | null | undefined;
        settings: WikiJudgeSettings;
        excludeFilter?: EgressFilter | undefined;
        maxCalls: number;
      }
    | undefined;
}

/** The sweep's `judge` dependency: present only when `maintenance.wikiLint.judge` is on, tool
 *  visibility does not disable `external-network`, AND a judge exists (a gateway judge role, or a TypeSafe backend that built) with a daily cap above 0. Absent
 *  leaves the sweep exactly as it was: no "judge: off" line in every summary. */
export function wikiLintSweepJudge(
  config: Pick<ServerConfig, "maintenance" | "wikiJudge" | "egress" | "toolVisibility">,
  roles: GatewayRoles | null,
  warn?: (msg: string) => void,
): WikiLintSweepDeps["judge"] {
  if (!config.maintenance.wikiLint.judge || config.wikiJudge.maxCallsPerDay <= 0) return undefined;
  // The sweep is not a tool, so tool visibility does not reach it; honour the one tag that says
  // "no note text leaves this process" the way lint_wiki itself is removed by it.
  if (config.toolVisibility?.disabledTags.includes("external-network")) return undefined;
  const excludeFilter = compileEgressFilter(config.egress.excludePaths);
  const backend = resolveWikiJudgeBackend(config.wikiJudge, roles, excludeFilter, warn);
  if (!backend) return undefined;
  return {
    roles,
    backend,
    settings: config.wikiJudge,
    excludeFilter,
    maxCalls: config.maintenance.wikiLint.judgeMaxCalls,
  };
}

export function summarizeLintReport(report: LintReport, judge?: PairJudgeReport): string {
  const kinds = Object.entries(report.summary.by_kind)
    .map(([k, n]) => `${k}=${n}`)
    .join(" ");
  const skipped = report.skipped.length
    ? ` (skipped: ${report.skipped.map((s) => s.check).join(", ")})`
    : "";
  const judged = judge
    ? judge.ran
      ? ` judge(${judge.model ?? "no model"}): ${
          Object.entries(judge.by_verdict)
            .map(([k, n]) => `${k}=${n}`)
            .join(" ") || "no verdicts"
        } unjudged=${judge.unjudged} calls=${judge.calls} cached=${judge.cached}`
      : ` judge: off (${judge.reason})`
    : "";
  return `[wiki-lint] ${report.vault}: ${report.summary.total} proposal(s)${kinds ? ` ${kinds}` : ""}${skipped}${judged}. Read-only; call lint_wiki for the list.\n`;
}

/** Register the sweep. The caller gates this on `maintenance.wikiLint.enabled`. */
export function registerWikiLintSweep(scheduler: Scheduler, deps: WikiLintSweepDeps): void {
  scheduler.register({
    name: "wiki-lint",
    intervalMs: deps.intervalMs,
    run: async (signal) => {
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
        let judge: PairJudgeReport | undefined;
        if (deps.judge) {
          // Operator-level read access, like the lint itself: there is no caller to scope to.
          judge = await judgeNearDuplicates(
            report,
            createWikiJudge({
              roles: deps.judge.roles,
              backend: deps.judge.backend,
              db: deps.cacheDb,
              settings: deps.judge.settings,
            }),
            {
              root: v.root,
              acl: undefined,
              grantedScopes: ["read:notes"],
              exclusion: deps.exclusionFor(v.id),
            },
            deps.judge.excludeFilter,
            deps.judge.maxCalls,
          );
        }
        if (deps.onReport) deps.onReport(report, judge);
        else process.stderr.write(summarizeLintReport(report, judge));
      }
    },
    onError: stderrOnError("wiki-lint"),
  });
}
