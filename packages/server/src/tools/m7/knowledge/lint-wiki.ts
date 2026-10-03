// lint_wiki: one read-only call that runs the wiki-health checks over a folder and returns
// PROPOSALS (never edits, never blocks). The engine is wiki-lint.ts, which the opt-in scheduled
// sweep (runtime/wiki-lint-sweep.ts) shares; this file is the MCP surface.
import { VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../../mcp/registry";
import { NOTE_DUPLICATE_MIN } from "../../../search/dedupe-band";
import { vaultExclusionFor } from "../../../search/index-exclusion";
import { normalizeVaultPath } from "../../../vault/paths";
import { defineTool } from "../../m1/define";
import { ResponseFormatInput, resolveResponseFormat } from "../../response-format";
import { scanWarningsShape } from "../../scan-warnings";
import type { M7Deps } from "./deps";
import { createWikiJudge, DEFAULT_WIKI_JUDGE_SETTINGS } from "./wiki-judge";
import { LINT_CHECKS, type Proposal, runWikiLint } from "./wiki-lint";
import {
  DEFAULT_LINT_JUDGE_CALLS,
  judgeNearDuplicates,
  PairJudgeReportSchema,
} from "./wiki-lint-judge";

const ProposalSchema = z.object({
  kind: z.enum([
    "generated_page",
    "orphan",
    "unresolved_link",
    "contradiction",
    "stale",
    "duplicate_chunks",
    "missing_sources",
    "coverage_gap",
    "near_duplicate",
  ]),
  subject: z.string(),
  related: z.array(z.string()).optional(),
  detail: z.string().optional(),
  suggested_action: z.string(),
  tool: z.string(),
  tool_args: z.record(z.string(), z.unknown()).optional(),
  evidence: z.record(z.string(), z.unknown()).optional(),
  // near_duplicate only, when the judge ruled on the pair (detailed: also under evidence.judge).
  judge_verdict: z.enum(["same_topic", "overlapping", "different"]).optional(),
});

export const LintWikiOutput = z.object({
  ...scanWarningsShape,
  vault: z.string(),
  folder: z.string().optional(),
  // Always true: this tool proposes, the caller applies.
  read_only: z.literal(true),
  checks_run: z.array(z.enum(LINT_CHECKS)),
  skipped: z.array(z.object({ check: z.enum(LINT_CHECKS), reason: z.string() })),
  summary: z.object({
    total: z.number().int(),
    by_kind: z.record(z.string(), z.number().int()),
  }),
  proposals: z.array(ProposalSchema),
  truncated: z.array(z.string()),
  notes: z.array(z.string()),
  // Present when the near-duplicate judge ran, or was asked for (judge=true) and could not.
  judge: PairJudgeReportSchema.optional(),
});

function conciseProposal(p: Proposal): z.infer<typeof ProposalSchema> {
  const verdict = (p.evidence?.judge as { verdict?: string } | undefined)?.verdict;
  return {
    ...(verdict ? { judge_verdict: verdict as "same_topic" | "overlapping" | "different" } : {}),
    kind: p.kind,
    subject: p.subject,
    ...(p.related ? { related: p.related } : {}),
    suggested_action: p.suggested_action,
    tool: p.tool,
  };
}

export function createLintWikiTool(deps: M7Deps): ToolDefinition {
  return defineTool({
    name: "lint_wiki",
    domain: "knowledge",
    description:
      "Wiki health check in ONE call: lint a folder (or the whole vault) and get a list of PROPOSED fixes, each with a suggested action and the tool that applies it. Combines find_orphans, find_unresolved_links (property links included), list_contradictions (open rows only), note_quality_report (stale / duplicated notes), audit_provenance (notes missing `sources`), gap_report (topics with no good page) and a NEW near-duplicate pass over note-level embeddings that finds pages restating the same topic (so you merge or link instead of keeping two), optionally with an LLM judge (judge=true) that reads each near-duplicate pair and adds a verdict (same_topic / overlapping / different) to the proposal. Use it for periodic wiki upkeep, after a batch of writes, or when asked to clean up, audit or dedupe a wiki. Read-only: it never writes and never blocks anything; apply the proposals with the named tool yourself. A check that cannot run (no rollup, no embeddings) is listed under `skipped` rather than failing the call. Respects the read ACL and Obsidian's Excluded files (an excluded note is never the subject of a proposal, but still counts as a link source and target). The wiki folder's generated index.md and log.md are never the subject of a proposal and their links count for nothing; a hand-edited or foreign one is reported as a `generated_page` proposal. Pick checks with `checks`; response_format=concise returns {kind, subject, related, suggested_action, tool} per proposal without detail, tool_args and evidence.",
    inputSchema: z
      .object({
        vault: VaultId,
        folder: VaultPath.optional().describe(
          "Lint only this folder. Links and duplicates are still resolved against the whole vault.",
        ),
        checks: z
          .array(z.enum(LINT_CHECKS))
          .min(1)
          .optional()
          .describe("Which checks to run. Default: all."),
        limit_per_check: z.number().int().positive().max(500).default(20),
        min_similarity: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(
            `Lowest note-level cosine reported as a near-duplicate (default ${NOTE_DUPLICATE_MIN}, calibrated for BAAI/bge-m3; candidates to review, not verdicts).`,
          ),
        max_notes: z
          .number()
          .int()
          .positive()
          .max(5000)
          .default(1500)
          .describe(
            "Cap on notes compared pairwise by the near-duplicate pass (cost grows with its square).",
          ),
        judge: z
          .boolean()
          .optional()
          .describe(
            "Have an LLM judge read each near-duplicate pair and put its verdict (same_topic, overlapping, different) and rationale on the proposal. It never drops a proposal. Sends the opening text of both notes to the judge model (the gateway's, or TypeSafe Jev), only for notes you may read outside egress.excludePaths and Obsidian's Excluded files. Default: on when a judge is configured (wikiJudge.lintEnabled); false skips it, true reports why when no judge is available.",
          ),
        max_judge_calls: z
          .number()
          .int()
          .positive()
          .max(50)
          .default(DEFAULT_LINT_JUDGE_CALLS)
          .describe(
            "Cap on judge calls in this run, highest-similarity pairs first (cached verdicts are free). Pairs beyond it keep their proposal unjudged. The wikiJudge.maxCallsPerDay cap applies on top.",
          ),
        ...ResponseFormatInput,
      })
      .strict(),
    outputSchema: LintWikiOutput,
    requiredScopes: ["read:notes"],
    tags: ["knowledge", "diagnostics", "external-network"],
    handler: async (input, ctx) => {
      const v = deps.vaultRegistry.resolve(input.vault);
      const exclusion = vaultExclusionFor(deps.vaultRegistry, v.id);
      let sealKey: string | undefined;
      try {
        sealKey = deps.wikiGeneratedSealKeyForLint?.();
      } catch (e) {
        process.stderr.write(
          `[wiki-lint] ${v.id}: generated-page seal check skipped: ${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
      const report = runWikiLint(
        {
          root: v.root,
          db: ctx.db,
          ...(deps.edb ? { edb: deps.edb } : {}),
          acl: ctx.acl,
          grantedScopes: ctx.grantedScopes,
          exclusion,
          embeddingModel: deps.embeddingProvider.id,
          wikiFolder: v.wikiFolder,
          rawFolder: v.rawFolder,
          sealKey,
        },
        {
          vaultId: v.id,
          folder: input.folder ? normalizeVaultPath(input.folder) : undefined,
          checks: input.checks ?? LINT_CHECKS,
          limitPerCheck: input.limit_per_check,
          minSimilarity: input.min_similarity,
          maxNotes: input.max_notes,
        },
      );
      // The near-duplicate judge. Only the near_duplicates check produces pairs to rule on.
      const settings = deps.wikiJudge ?? DEFAULT_WIKI_JUDGE_SETTINGS;
      const wiki = createWikiJudge({
        roles: deps.roles,
        backend: deps.wikiJudgeBackend,
        db: ctx.db,
        settings,
      });
      const asked = input.judge ?? (settings.lintEnabled && wiki.available);
      let judge: z.infer<typeof PairJudgeReportSchema> | undefined;
      if (asked) {
        judge = await judgeNearDuplicates(
          report,
          wiki,
          { root: v.root, acl: ctx.acl, grantedScopes: ctx.grantedScopes, exclusion },
          deps.excludeFilter,
          input.max_judge_calls,
        );
        // A default-on judge with nothing to do stays out of the answer; an explicit ask is answered.
        if (input.judge !== true && !judge.ran) judge = undefined;
      }
      const concise = resolveResponseFormat(input, deps.responseFormat) === "concise";
      const { warnings, ...rest } = report;
      return {
        ...warnings,
        ...rest,
        ...(judge ? { judge } : {}),
        read_only: true as const,
        proposals: concise ? report.proposals.map(conciseProposal) : report.proposals,
      };
    },
  });
}
