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
import { LINT_CHECKS, type Proposal, runWikiLint } from "./wiki-lint";

const ProposalSchema = z.object({
  kind: z.enum([
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
});

function conciseProposal(p: Proposal): z.infer<typeof ProposalSchema> {
  return {
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
      "Wiki health check in ONE call: lint a folder (or the whole vault) and get a list of PROPOSED fixes, each with a suggested action and the tool that applies it. Combines find_orphans, find_unresolved_links (property links included), list_contradictions (open rows only), note_quality_report (stale / duplicated notes), audit_provenance (notes missing `sources`), gap_report (topics with no good page) and a NEW near-duplicate pass over note-level embeddings that finds pages restating the same topic (so you merge or link instead of keeping two). Use it for periodic wiki upkeep, after a batch of writes, or when asked to clean up, audit or dedupe a wiki. Read-only: it never writes and never blocks anything; apply the proposals with the named tool yourself. A check that cannot run (no rollup, no embeddings) is listed under `skipped` rather than failing the call. Respects the read ACL and Obsidian's Excluded files (an excluded note is never the subject of a proposal, but still counts as a link source and target). Pick checks with `checks`; response_format=concise returns {kind, subject, related, suggested_action, tool} per proposal without detail, tool_args and evidence.",
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
        ...ResponseFormatInput,
      })
      .strict(),
    outputSchema: LintWikiOutput,
    requiredScopes: ["read:notes"],
    tags: ["knowledge", "diagnostics"],
    handler: (input, ctx) => {
      const v = deps.vaultRegistry.resolve(input.vault);
      const report = runWikiLint(
        {
          root: v.root,
          db: ctx.db,
          ...(deps.edb ? { edb: deps.edb } : {}),
          acl: ctx.acl,
          grantedScopes: ctx.grantedScopes,
          exclusion: vaultExclusionFor(deps.vaultRegistry, v.id),
          embeddingModel: deps.embeddingProvider.id,
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
      const concise = resolveResponseFormat(input, deps.responseFormat) === "concise";
      const { warnings, ...rest } = report;
      return {
        ...warnings,
        ...rest,
        read_only: true as const,
        proposals: concise ? report.proposals.map(conciseProposal) : report.proposals,
      };
    },
  });
}
