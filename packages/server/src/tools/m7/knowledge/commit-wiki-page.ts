// commit_wiki_page: the last step of the wiki workflow. It applies a changeset (one page plus the
// additive patches that link the related pages to it) as ONE unit: every touched note is checked
// first (ACL, compare-and-swap, the poison and memory-defense scans), and only then are the writes
// made, with a rollback if one of them fails. The prose is the caller's; the server adds nothing.
//
// What stops a commit (an error, nothing written): a vault with no wiki folder configured, a page
// outside it, a write or read the ACL denies, a stale `prev_hash`, a path that cannot take the
// write, content the poison scan rejects, a topic that already has a page (unless
// `allow_duplicate`). What does NOT stop it: schema, link and contradiction findings. Those come
// back as `problems` / `contradictions` for the caller to fix with a later patch_note, because a
// wiki that refuses a write over a missing property is a wiki nobody writes to.
//
// Confirmation, per operation, as the single-note tools ask it: creating a page inside the wiki
// folder needs none (a new page has no prior state, so no snapshot: delete_note, which asks, removes
// it); overwriting an existing non-empty page asks exactly as write_note does; patching a related
// note anywhere asks nothing, as patch_note does, under the same ACL (read and write). Each
// overwritten or patched note is snapshotted first, and restore_note undoes those.
//
// Atomicity: all or nothing on every error this process can catch. A process crash between two
// renames can leave a partial batch; vault/write-batch.ts says how that is bounded and recorded.
import { ElicitToken, err, ObsidianTcError, VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import {
  enforceMemoryDefenseOnNoteWrite,
  MEMORY_DEFENSE_OFF,
} from "../../../experiential/memory-defense";
import { assessPoison } from "../../../experiential/poison";
import type { ToolDefinition } from "../../../mcp/registry";
import { vaultExclusionFor } from "../../../search/index-exclusion";
import { errorMessage } from "../../../util/errors";
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
import {
  contentHash,
  normalizeVaultPath,
  resolveVaultPath,
  resolveVaultPathChecked,
} from "../../../vault/paths";
import { captureSnapshot, discardSnapshots, pruneSnapshots } from "../../../vault/snapshots";
import { applyWriteBatch, type BatchWrite, isIncompleteRollback } from "../../../vault/write-batch";
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
import { collectIdentityEvidence } from "./wiki-evidence";
import { assertWikiPagePath, filesystemIdentity, rawPathFilter } from "./wiki-folder";
import { regenerateWikiPages, type WikiGenerateEnv } from "./wiki-generated";
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
    "excluded_note",
    "poison_suspect",
    "redacted",
    "generated_page",
    "post_commit",
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
  type GenerationSnapshot = Omit<WikiGenerateEnv, "sealKey">;
  interface GenerationState {
    dirty: boolean;
    scheduled: boolean;
    snapshot: GenerationSnapshot;
  }
  const generationByVault = new Map<string, GenerationState>();
  const schedule = deps.scheduleWikiPageRegeneration ?? ((run: () => void) => setImmediate(run));
  const scheduleState = (vaultId: string, state: GenerationState): void => {
    if (state.scheduled) return;
    state.scheduled = true;
    try {
      schedule(() => {
        state.scheduled = false;
        if (!state.dirty) {
          if (generationByVault.get(vaultId) === state) generationByVault.delete(vaultId);
          return;
        }
        state.dirty = false;
        const snapshot = state.snapshot;
        try {
          const sealKey = deps.wikiGeneratedSealKey?.();
          if (sealKey === undefined) throw new Error("generated-page HMAC key is unavailable");
          const result = regenerateWikiPages({ ...snapshot, sealKey });
          if (result.warnings.length > 0)
            process.stderr.write(
              `[wiki-pages] ${vaultId}: ${result.warnings.map((w) => `${w.path} (${w.kind}: ${w.message})`).join("; ")}\n`,
            );
        } catch (e) {
          process.stderr.write(
            `[wiki-pages] ${vaultId}: queued regeneration failed: ${e instanceof Error ? e.message : String(e)}\n`,
          );
        }
        if (state.dirty) scheduleState(vaultId, state);
        else if (generationByVault.get(vaultId) === state) generationByVault.delete(vaultId);
      });
    } catch (e) {
      state.scheduled = false;
      if (generationByVault.get(vaultId) === state) generationByVault.delete(vaultId);
      process.stderr.write(
        `[wiki-pages] ${vaultId}: could not queue regeneration: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  };
  const enqueueGeneration = (snapshot: GenerationSnapshot): void => {
    const prior = generationByVault.get(snapshot.vaultId);
    const state = prior ?? { dirty: false, scheduled: false, snapshot };
    state.snapshot = snapshot;
    state.dirty = true;
    if (!prior) generationByVault.set(snapshot.vaultId, state);
    scheduleState(snapshot.vaultId, state);
  };

  return defineTool({
    name: "commit_wiki_page",
    domain: "knowledge",
    vaultArg: "vault",
    // Every note that already exists is read (its hash is compared and returned, its text patched)
    // as well as written, so it needs the read ACL too; a new page is only written.
    pathAcl: (input) => [
      { op: "write" as const, path: input.page.path },
      ...(input.page.mode === "overwrite" ? [{ op: "read" as const, path: input.page.path }] : []),
      ...input.patches.flatMap((p) => [
        { op: "write" as const, path: p.path },
        { op: "read" as const, path: p.path },
      ]),
    ],
    description:
      "Apply a wiki changeset in one step: a new page (path, frontmatter, the body you wrote) plus patches to existing pages that link them to it, from draft_wiki_page. The page must be inside the vault's configured wiki folder (`vaults[].wiki.folder`; a vault without one refuses). All or nothing on errors: every touched note is checked first (write and read ACL on each path, `prev_hash` compare-and-swap on each existing note, the poison and memory-defense scans), temp files for every note are staged, then the notes are replaced back to back, each re-hashed just before it is replaced, with a rollback if any write fails, so a failing patch leaves the vault as it was. NOT crash-atomic: a process crash in the middle of the renames can leave a partial batch; a `pending` write-provenance record naming every path and the hash it was about to hold is written before the first rename, so the batch is visible and every replaced note has a snapshot (restore_note). Creating a page in the wiki folder needs NO confirmation (a new page has no prior state, so it has no snapshot: delete_note removes it); patching a related note needs none either, as patch_note, and restore_note undoes patches and overwrites; overwriting an existing non-empty page (`page.mode: overwrite`) asks for confirmation exactly like write_note. Re-checks at commit time that no other page already covers the topic (an identity match refuses the commit with the existing page named; `allow_duplicate: true` overrides). Problems that are for you to fix do NOT block the write and come back in `problems`: frontmatter that breaks the wiki folder's SCHEMA.md (missing required field, unknown type or property, value outside the vocabulary), links in the page that resolve to no note, related notes from the link map the page does not link, patches that add no link, a page nothing links to. Open contradictions already flagged on a touched note come back in `contradictions`. Patches only ADD (`link`: a bullet under a heading, once; `append`: text at the end or under a heading); rewrite prose with patch_note. Every write is recorded in the write provenance chain and indexed. Snapshot retention and reindexing after the write are best-effort: a fault there is logged and comes back as a `post_commit` problem, never as an error. After the write the server queues regeneration of the wiki folder's generated `index.md` (pages grouped by type) and `log.md` (a projection of the write provenance chain), so even a very large wiki never delays this call. Generation lists only paths readable without a rule-scope and never an Excluded note; failures and hand-edited generated pages are logged and never fail or delay the committed write. Needs read:notes as well as write:notes: the duplicate re-check reads every note you may read.",
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
        // Advertised so a caller can discover the confirmation parameter; stripped off rawArgs into
        // ctx.elicitToken before this schema validates (mcp/server.ts).
        elicit_token: ElicitToken.optional(),
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
    // read:notes too: the duplicate re-check reads every ACL-visible note and names the matches.
    requiredScopes: ["write:notes", "read:notes"],
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
      // One filesystem entry, one changeset entry. Existing paths use dev+ino, so symlink and
      // case-insensitive aliases collide while two real case-distinct files do not. A path that is
      // not created yet has no inode and falls back to its exact normalised spelling.
      const seen = new Set<string>();
      for (const rel of [pageRel, ...patchRels]) {
        const resolved = resolveVaultPathChecked(v.root, rel).aclRel;
        const key = filesystemIdentity(v.root, resolved) ?? `new:${resolved}`;
        if (seen.has(key))
          throw err.invalidInput("a path may appear once in a changeset (page or patch)", {
            path: rel,
          });
        seen.add(key);
      }
      for (const rel of [pageRel, ...patchRels])
        enforcePathAcl(ctx.acl, "write", rel, v.root, ctx.grantedScopes);
      // Handler-side read check, defense in depth beside the central one: a note the caller may
      // write but not read answers exactly like a missing one, before its bytes or hash are touched.
      const requireReadable = (rel: string, what: string): void => {
        try {
          enforcePathAcl(ctx.acl, "read", rel, v.root, ctx.grantedScopes);
        } catch (e) {
          if (e instanceof ObsidianTcError && e.code === "acl_denied")
            throw err.noteNotFound(`${what} not found`, { path: rel });
          throw e;
        }
      };
      for (const rel of patchRels) requireReadable(rel, "note to patch");
      if (input.page.mode === "overwrite") requireReadable(pageRel, "page to overwrite");
      assertWikiPagePath(v.root, v.wikiFolder, pageRel);

      const scope = {
        root: v.root,
        acl: ctx.acl,
        grantedScopes: ctx.grantedScopes,
        wikiFolder: v.wikiFolder,
      };
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
      // The frontmatter checked is the frontmatter written, the server's provenance stamp included:
      // a wiki whose SCHEMA.md does not declare the stamp key is told so, not left to find it later.
      for (const p of checkFrontmatter(
        load.schema,
        parseNoteLenient(pageStamped, pageRel).frontmatter ?? null,
        input.type,
      ))
        problems.push({
          kind: "schema",
          path: pageRel,
          ...(p.field ? { field: p.field } : {}),
          message: p.message,
        });
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
      const settledDigests = new Map<string, string>([
        [pageRel, contentHash(pageContent)],
        ...outcomes
          .filter((o) => o.r.applied)
          .map((o): [string, string] => [o.t.rel, contentHash(o.content)]),
      ]);

      // The duplicate check above ran before an await; the disk may have changed since. Everything
      // from here to the last rename is synchronous, so this is the last look before the write: an
      // identity match (name, alias, id) on another page refuses the commit, as the first check does.
      if (!input.allow_duplicate) {
        const fresh = [
          ...collectIdentityEvidence(scope, topic, {
            folder: undefined,
            isExcluded: exclusion.isExcluded,
            ignore: rawPathFilter(v.rawFolders),
          }).candidates.values(),
        ].filter((c) => c.path !== pageRel);
        if (verdictOf(fresh) === "exists")
          throw err.conflict(
            `a page already covers "${topic}": ${fresh
              .slice(0, 3)
              .map((c) => c.path)
              .join(", ")}. It appeared while this commit was being prepared; nothing was written`,
            { reason: "duplicate_page", existing: fresh.slice(0, 3).map((c) => c.path), topic },
          );
      }

      // A snapshot of every existing note the batch replaces (a new page has nothing to save), taken
      // before the first temp file. Retention pruning waits for the batch to succeed, and a failed
      // batch drops the rows it added, so an aborted commit never evicts an older recovery point.
      const snapshotIds: number[] = [];
      try {
        for (const w of writes) {
          if (w.prevRaw === null) continue;
          const id = captureSnapshot(
            ctx.db,
            deps.snapshots,
            v.id,
            w.rel,
            w.prevRaw,
            "commit_wiki_page",
            ctx.now,
            false,
          );
          if (id !== null) snapshotIds.push(id);
        }
        applyWriteBatch(writes, {
          // The batch's durable intent, before the first note is replaced: a crash from here on
          // leaves a `pending` provenance record naming every path and the hash it was to hold.
          beforeCommit: () => ctx.recordPendingWrite?.(settledDigests),
        });
      } catch (e) {
        // A clean rollback leaves the vault as it was, so this call's snapshots are noise. An
        // incomplete or diverged one is the case the error sends the caller to restore_note for:
        // the pre-images are then the only way back, so they stay.
        if (!isIncompleteRollback(e)) discardSnapshots(ctx.db, snapshotIds);
        throw e;
      }
      // The batch has landed: nothing below can take it back, so nothing below may turn the call into
      // an error. Retention and reindexing are best-effort; a fault is logged and returned as a
      // warning, and the next write's pass catches up.
      const authored = problems.length;
      const postCommit = (what: string, fn: () => void): void => {
        try {
          fn();
        } catch (e) {
          const message = `${what} failed after the write landed: ${errorMessage(e)}`;
          process.stderr.write(`[commit_wiki_page] ${v.id}: ${message}\n`);
          problems.push({ kind: "post_commit", message });
        }
      };
      if (deps.snapshots?.enabled) {
        const { retention } = deps.snapshots;
        for (const w of writes)
          if (w.prevRaw !== null)
            postCommit(`snapshot retention for ${w.rel}`, () =>
              pruneSnapshots(ctx.db, v.id, w.rel, retention),
            );
      }
      for (const w of writes)
        postCommit(`reindexing ${w.rel}`, () => deps.reindex?.(v.id, w.rel, w.content));

      // The generated index.md / log.md are deliberately outside the request path: a 5,000-page
      // folder takes seconds to scan on modest hardware. The queued pass is never part of the
      // committed batch; failures are operator-visible and cannot turn the successful write back
      // into an error.
      enqueueGeneration({
        root: v.root,
        vaultId: v.id,
        wikiFolder,
        acl: ctx.acl,
        exclusion,
        db: ctx.db,
        snapshots: deps.snapshots,
        memoryDefense: mdConfig,
        metrics: deps.metrics,
        now: ctx.now,
      });

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
          ...(authored > 0
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
