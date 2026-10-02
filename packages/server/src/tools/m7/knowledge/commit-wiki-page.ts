// commit_wiki_page: the last step of the wiki workflow. It applies a changeset (one page plus the
// additive patches that link the related pages to it) as ONE unit: every touched note is checked
// first (ACL, compare-and-swap, the poison and memory-defense scans), and only then are the writes
// made, with a rollback if one of them fails. The prose is the caller's; the server adds nothing.
//
// What stops a commit (an error, nothing written): a write the ACL denies, a stale `prev_hash`, a
// path that cannot take the write, content the poison scan rejects, a topic that already has a page
// (unless `allow_duplicate`). What does NOT stop it: schema, link and contradiction findings. Those
// come back as `problems` / `contradictions` for the caller to fix with a later patch_note, because
// a wiki that refuses a write over a missing property is a wiki nobody writes to.
//
// Confirmation: creating a page needs none, in the wiki folder or out of it (restore_note undoes
// it, and each overwritten or patched note is snapshotted first). Overwriting an existing non-empty
// page asks exactly as write_note does, wherever it lives.
import { err, VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import {
  enforceMemoryDefenseOnNoteWrite,
  MEMORY_DEFENSE_OFF,
} from "../../../experiential/memory-defense";
import { assessPoison } from "../../../experiential/poison";
import type { ToolDefinition } from "../../../mcp/registry";
import { vaultExclusionFor } from "../../../search/index-exclusion";
import { enforcePathAcl } from "../../../vault/acl-path";
import { readableRel } from "../../../vault/acl-read-filter";
import { parseNoteLenient, serializeNote } from "../../../vault/frontmatter";
import { requireConfirmation } from "../../../vault/hitl";
import {
  buildVaultIndex,
  extractLinks,
  extractNoteLinks,
  resolveTarget,
} from "../../../vault/links";
import { noteExists, readNote } from "../../../vault/notes-io";
import { contentHash, normalizeVaultPath, resolveVaultPath } from "../../../vault/paths";
import { captureSnapshot } from "../../../vault/snapshots";
import { applyWriteBatch, type BatchWrite } from "../../../vault/write-batch";
import {
  createModeConflictError,
  overwriteModeMissingError,
} from "../../../vault/write-mode-errors";
import { defineTool } from "../../m1/define";
import type { M7Deps } from "./deps";
import { findExistingPage, verdictOf } from "./find-existing-page";
import { openContradictionsForPaths, type RetrievalRuntime } from "./retrieval-runtime";
import {
  computePatch,
  linksTo,
  MAX_PATCHES,
  type PatchOutcome,
  WikiPageSpec,
  WikiPatchSpec,
} from "./wiki-changeset";
import { buildLinkMap } from "./wiki-link-map";
import { checkFrontmatter, loadWikiSchema } from "./wiki-schema";

const ProblemSchema = z.object({
  kind: z.enum([
    "schema",
    "schema_file",
    "unresolved_link",
    "missing_link",
    "no_inbound_link",
    "patch_without_link",
    "patch_skipped",
    "possible_duplicate",
    "outside_wiki_folder",
    "excluded_note",
    "poison_suspect",
    "redacted",
  ]),
  path: z.string().optional(),
  field: z.string().optional(),
  message: z.string(),
});
type Problem = z.infer<typeof ProblemSchema>;

export const CommitWikiPageOutput = z.object({
  vault: z.string(),
  committed: z.literal(true),
  page: z.object({
    path: z.string(),
    created: z.boolean(),
    content_hash: z.string(),
    prev_hash: z.string().nullable(),
  }),
  patches: z.array(
    z.object({
      path: z.string(),
      operation: z.enum(["link", "append"]),
      applied: z.boolean(),
      /** Why a patch changed nothing (the note already links the page). */
      reason: z.string().optional(),
      content_hash: z.string(),
      prev_hash: z.string(),
    }),
  ),
  /** Everything the commit noticed and did not refuse: fix these with patch_note / write_note. */
  problems: z.array(ProblemSchema),
  /** Open contradictions the detector already flagged on a touched note. Reported, never blocking. */
  contradictions: z.array(
    z.object({
      id: z.string(),
      source_path: z.string(),
      conflict_path: z.string(),
      judge_verdict: z.string(),
      judge_rationale: z.string(),
    }),
  ),
  dedupe: z.object({ verdict: z.enum(["exists", "ambiguous", "new"]), checked_topic: z.string() }),
  /** Matches replaced by memoryDefense (mode redact) across everything written. */
  redactions: z.number().int().optional(),
  next: z.array(z.string()),
});

const basename = (rel: string): string => (rel.split("/").pop() ?? rel).replace(/\.md$/i, "");

export function createCommitWikiPageTool(
  deps: M7Deps,
  retrieval: RetrievalRuntime,
): ToolDefinition {
  return defineTool({
    name: "commit_wiki_page",
    domain: "knowledge",
    vaultArg: "vault",
    pathAcl: (input) => [
      { op: "write", path: input.page.path },
      ...input.patches.map((p) => ({ op: "write" as const, path: p.path })),
    ],
    description:
      "Apply a wiki changeset in ONE atomic step: a new page (path, frontmatter, the body you wrote) plus patches to existing pages that link them to it, from draft_wiki_page. All or nothing: every touched note is checked first (write ACL on each path, `prev_hash` compare-and-swap on each existing note, the poison and memory-defense scans), then written with a rollback if any write fails, so a failing patch leaves the vault exactly as it was. Creating a page needs NO confirmation (restore_note undoes it; each patched or overwritten note is snapshotted first); overwriting an existing non-empty page (`page.mode: overwrite`) asks for confirmation exactly like write_note. Re-checks at commit time that no other page already covers the topic (an identity match refuses the commit with the existing page named; `allow_duplicate: true` overrides). Problems that are for you to fix do NOT block the write and come back in `problems`: frontmatter that breaks the wiki folder's SCHEMA.md (missing required field, unknown type or property, value outside the vocabulary), links in the page that resolve to no note, related notes from the link map the page does not link, patches that add no link, a page nothing links to. Open contradictions already flagged on a touched note come back in `contradictions`. Patches only ADD (`link`: a bullet under a heading, once; `append`: text at the end or under a heading); rewrite prose with patch_note. Every write is recorded in the write provenance chain and indexed.",
    inputSchema: z
      .object({
        vault: VaultId,
        topic: z
          .string()
          .min(1)
          .max(500)
          .optional()
          .describe(
            "What the page covers, for the duplicate check and link validation. Default: the page's file name.",
          ),
        type: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe(
            "Page type to check the frontmatter against. Default: the frontmatter's `type`.",
          ),
        sources: z
          .array(z.string().min(1).max(1000))
          .max(50)
          .optional()
          .describe("Notes or URLs the page draws on; notes among them are expected to be linked."),
        page: WikiPageSpec,
        patches: z.array(WikiPatchSpec).max(MAX_PATCHES).default([]),
        allow_duplicate: z
          .boolean()
          .default(false)
          .describe("Create the page even though another page already covers the topic."),
        judge: z
          .boolean()
          .optional()
          .describe(
            "Let the wikiJudge LLM resolve an ambiguous duplicate check. Default: the wikiJudge.enabled config.",
          ),
      })
      .strict(),
    outputSchema: CommitWikiPageOutput,
    requiredScopes: ["write:notes"],
    conditionallyDestructive: true,
    tags: ["knowledge", "external-network"],
    handler: async (input, ctx) => {
      const v = deps.vaultRegistry.resolve(input.vault);
      const pageRel = normalizeVaultPath(input.page.path);
      if (!/\.md$/i.test(pageRel))
        throw err.invalidInput("page.path must end in .md", { path: pageRel });
      if (/^---[ \t]*\r?\n/.test(input.page.body))
        throw err.invalidInput(
          "page.body starts with a frontmatter block; pass the properties as `page.frontmatter` instead",
          { path: pageRel },
        );
      const patchRels = input.patches.map((p) => normalizeVaultPath(p.path));
      const seen = new Set([pageRel]);
      for (const rel of patchRels) {
        if (seen.has(rel))
          throw err.invalidInput("a path may appear once in a changeset (page or patch)", {
            path: rel,
          });
        seen.add(rel);
      }
      for (const rel of [pageRel, ...patchRels])
        enforcePathAcl(ctx.acl, "write", rel, v.root, ctx.grantedScopes);

      const scope = { root: v.root, acl: ctx.acl, grantedScopes: ctx.grantedScopes };
      const pageAbs = resolveVaultPath(v.root, pageRel);
      // The page's mode against the disk. Run before the await so a plain mistake (creating over a
      // page, overwriting a missing one) gets its own error, not a duplicate-topic one; run again
      // after it, because the disk may have changed meanwhile.
      const checkPageMode = (): void => {
        const ex = noteExists(pageAbs);
        if (ex.exists && ex.type === "folder")
          throw err.invalidInput("path is a folder", { path: pageRel });
        if (input.page.mode === "create") {
          if (ex.exists) throw createModeConflictError(pageRel);
        } else {
          if (!ex.exists) throw overwriteModeMissingError(pageRel);
          if (input.page.prev_hash === undefined)
            throw err.invalidInput("page.prev_hash is required to overwrite an existing page", {
              path: pageRel,
            });
        }
      };
      checkPageMode();
      const topic = input.topic ?? basename(pageRel);
      const problems: Problem[] = [];

      // The one await: the duplicate re-check. Everything after it is synchronous, so nothing in
      // this process can slip between reading the notes and writing them.
      const { output, ranked, scan } = await findExistingPage(deps, retrieval, ctx, v, {
        topic,
        limit: 25,
        judge: input.judge,
        concise: true,
      });
      const others = ranked.filter((c) => c.path !== pageRel);
      const judgedSame =
        output.judged_by?.verdict === "same_topic" &&
        output.judged_by.paths.some((p) => p !== pageRel);
      if (!input.allow_duplicate && (verdictOf(others) === "exists" || judgedSame)) {
        const existing = (
          judgedSame ? (output.judged_by?.paths ?? []) : others.slice(0, 3).map((c) => c.path)
        ).filter((p) => p !== pageRel);
        throw err.conflict(
          `a page already covers "${topic}": ${existing.join(", ")}. Link to it or extend it with append_note / patch_note, or pass allow_duplicate: true if this is a different topic`,
          { reason: "duplicate_page", existing, topic },
        );
      }
      if (others.length > 0 && verdictOf(others) === "ambiguous")
        problems.push({
          kind: "possible_duplicate",
          message: `these notes may already cover "${topic}": ${others
            .slice(0, 3)
            .map((c) => c.path)
            .join(", ")}`,
        });

      const wikiFolder = v.wikiFolder;
      const exclusion = vaultExclusionFor(deps.vaultRegistry, v.id);
      const load = loadWikiSchema(scope, wikiFolder);
      for (const w of load.warnings)
        problems.push({ kind: "schema_file", path: load.path, message: w });
      const inWiki = !wikiFolder || pageRel.startsWith(`${wikiFolder}/`);
      if (!inWiki)
        problems.push({
          kind: "outside_wiki_folder",
          path: pageRel,
          message: `the page is outside the wiki folder (${wikiFolder}), so SCHEMA.md was not applied`,
        });
      else
        for (const p of checkFrontmatter(load.schema, input.page.frontmatter ?? null, input.type))
          problems.push({
            kind: "schema",
            path: pageRel,
            ...(p.field ? { field: p.field } : {}),
            message: p.message,
          });

      // Read every existing note the changeset touches, and check them all before judging any one.
      const stale: Array<{ path: string; expected: string; actual: string }> = [];
      const checkCas = (path: string, expected: string | undefined, actual: string): void => {
        if (expected !== undefined && expected !== actual) stale.push({ path, expected, actual });
      };
      checkPageMode();
      let pagePrev: { raw: string; hash: string } | null = null;
      if (input.page.mode === "overwrite") {
        pagePrev = readNote(pageAbs);
        checkCas(pageRel, input.page.prev_hash, pagePrev.hash);
      }
      const targets = input.patches.map((spec, i) => {
        const rel = patchRels[i] as string;
        const abs = resolveVaultPath(v.root, rel);
        const ex = noteExists(abs);
        if (!ex.exists || ex.type === "folder")
          throw err.noteNotFound("note to patch not found", { path: rel });
        const cur = readNote(abs);
        checkCas(rel, spec.prev_hash, cur.hash);
        return { spec, rel, abs, cur };
      });
      if (stale.length > 0)
        throw err.concurrentModification(
          `${stale.map((s) => s.path).join(", ")} changed since prev_hash; nothing was written. Re-read, re-draft and commit again`,
          { path: stale[0]?.path, expected: stale[0]?.expected, actual: stale[0]?.actual, stale },
        );

      // Compute every resulting note.
      const base = basename(pageRel).toLowerCase();
      const sameName = scan.notes.some((n) => n !== pageRel && basename(n).toLowerCase() === base);
      const pageTarget = pageRel.replace(/\.md$/i, "");
      const link = `[[${sameName ? pageTarget : basename(pageRel)}]]`;
      const names = new Set([pageTarget.toLowerCase(), base]);
      const mdConfig = deps.memoryDefense?.(v.id) ?? MEMORY_DEFENSE_OFF;
      let redactions = 0;
      const guard = (rel: string, content: string): string => {
        const scanned = enforceMemoryDefenseOnNoteWrite(mdConfig, rel, content, {
          metrics: deps.metrics,
        });
        if (scanned.redactions > 0) {
          redactions += scanned.redactions;
          problems.push({
            kind: "redacted",
            path: rel,
            message: `${scanned.redactions} secret-shaped match(es) were replaced by [REDACTED]`,
          });
        }
        return scanned.content;
      };
      const vet = (rel: string, authored: string): void => {
        const poison = assessPoison(authored);
        if (poison.risk === "high")
          throw err.contentRejected(
            "content failed the poison scan (risk: high); nothing was written",
            {
              path: rel,
              signals: poison.signals,
            },
          );
        if (poison.risk === "suspect")
          problems.push({
            kind: "poison_suspect",
            path: rel,
            message: `the text trips the poison scan (${poison.signals.join(", ")}); check it was meant`,
          });
      };

      vet(pageRel, input.page.body);
      const pageRaw = serializeNote(input.page.frontmatter ?? null, input.page.body, null, {
        path: pageRel,
      });
      const pageStamped = pagePrev
        ? pageRaw
        : (deps.provenanceStamp?.stampNewNote(pageRaw, v.id, ctx) ?? pageRaw);
      const pageContent = guard(pageRel, pageStamped);

      const outcomes: Array<{ t: (typeof targets)[number]; r: PatchOutcome; content: string }> = [];
      for (const t of targets) {
        const r = computePatch(t.cur.raw, t.spec, t.rel, { link, names });
        if (r.applied) {
          vet(t.rel, r.added);
          if (t.spec.operation === "append" && !linksTo(extractLinks(r.added), names))
            problems.push({
              kind: "patch_without_link",
              path: t.rel,
              message: "this appended text does not link the new page",
            });
          if (exclusion.isExcluded(t.rel))
            problems.push({
              kind: "excluded_note",
              path: t.rel,
              message: "this note is left out of the index by Obsidian's Excluded files",
            });
        } else
          problems.push({
            kind: "patch_skipped",
            path: t.rel,
            message: "the note already links the new page; nothing was added",
          });
        outcomes.push({ t, r, content: r.applied ? guard(t.rel, r.content) : t.cur.raw });
      }

      // Links in the page, against the vault and the link map.
      const index = buildVaultIndex([...scan.notes.filter((n) => n !== pageRel), pageRel]);
      const written = parseNoteLenient(pageContent);
      const linked = new Set<string>();
      for (const l of extractNoteLinks(written)) {
        if (l.inCodeblock || l.kind === "embed" || l.target === "") continue;
        const external = /^[a-z][a-z0-9+.-]*:/i.test(l.target);
        const attachment = /\.[A-Za-z0-9]{1,5}$/.test(l.target) && !/\.md$/i.test(l.target);
        if (external || attachment) continue;
        const r = resolveTarget(index, l.target);
        if (r.resolved && r.target_path) linked.add(r.target_path);
        else
          problems.push({
            kind: "unresolved_link",
            path: pageRel,
            message: `[[${l.target}]] (line ${l.line}) resolves to no note`,
          });
      }
      const map = buildLinkMap({
        ranked,
        scan,
        sources: input.sources ?? [],
        wikiFolder,
        selfPath: pageRel,
        isExcluded: exclusion.isExcluded,
      });
      for (const e of map.link_to.filter((x) => !linked.has(x.path)).slice(0, 10))
        problems.push({
          kind: "missing_link",
          path: e.path,
          message: `related note not linked from the page (${e.reasons.join(", ")})`,
        });
      const appliedPatches = outcomes.filter((o) => o.r.applied).length;
      if (appliedPatches === 0 && map.already_linking.length === 0)
        problems.push({
          kind: "no_inbound_link",
          path: pageRel,
          message: "nothing links to this page yet: add a patch to a related note",
        });

      const touched = [...(pagePrev ? [pageRel] : []), ...patchRels];
      const contradictions = openContradictionsForPaths(ctx.db, v.id, touched, (rel) =>
        readableRel(ctx.acl, rel, ctx.grantedScopes),
      );

      // The same rule write_note applies to an overwrite of a non-empty note, unchanged.
      requireConfirmation(
        ctx,
        "commit_wiki_page",
        input,
        pagePrev !== null && pagePrev.raw.length > 0,
        { path: pageRel, mode: "overwrite", prev_hash: pagePrev?.hash ?? null },
      );

      const writes: BatchWrite[] = [
        { abs: pageAbs, rel: pageRel, content: pageContent, prevRaw: pagePrev?.raw ?? null },
        ...outcomes
          .filter((o) => o.r.applied)
          .map((o) => ({ abs: o.t.abs, rel: o.t.rel, content: o.content, prevRaw: o.t.cur.raw })),
      ];
      applyWriteBatch(writes, (w) => {
        if (w.prevRaw !== null)
          captureSnapshot(
            ctx.db,
            deps.snapshots,
            v.id,
            w.rel,
            w.prevRaw,
            "commit_wiki_page",
            ctx.now,
          );
      });
      for (const w of writes) deps.reindex?.(v.id, w.rel, w.content);

      return {
        vault: v.id,
        committed: true as const,
        page: {
          path: pageRel,
          created: pagePrev === null,
          content_hash: contentHash(pageContent),
          prev_hash: pagePrev?.hash ?? null,
        },
        patches: outcomes.map(({ t, r, content }) => ({
          path: t.rel,
          operation: t.spec.operation,
          applied: r.applied,
          ...(r.applied ? {} : { reason: r.reason }),
          content_hash: contentHash(content),
          prev_hash: t.cur.hash,
        })),
        problems,
        contradictions,
        dedupe: { verdict: output.verdict, checked_topic: topic },
        ...(redactions > 0 ? { redactions } : {}),
        next: [
          ...(problems.length > 0
            ? [
                "Fix the listed problems with patch_note or write_note; the pages are already written.",
              ]
            : []),
          "Run lint_wiki now and then to catch orphans, stale pages and near-duplicates.",
        ],
      };
    },
  });
}
