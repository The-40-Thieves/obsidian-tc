// Domain 21 — Capture / inbox queue (G2.1). Three tools over the SQLite
// capture_queue: enqueue_capture stages content (no vault write), list_capture_queue
// reads it, commit_capture materializes a queued capture to a vault note. Scopes
// follow M4's resolved read/write split (the G2.1 "execute on capture bridge" wording
// predates that fix): reads take read:capture, mutations take write:capture (write
// family — ACL readOnly kill-switch applies, no always-elicit execute floor, matching
// the spec's hitl:never). commit_capture is the only vault write; it funnels through
// resolveVaultPath + enforcePathAcl and refuses to clobber an existing note.
import { err, Pagination, VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import {
  type CaptureRow,
  captureCursor,
  deleteCapture,
  enqueueCapture,
  getCapture,
  listCaptures,
  markCommitted,
} from "../../capture/queue";
import { inTransaction } from "../../db/txn";
import type { ToolDefinition } from "../../mcp/registry";
import { enforcePathAcl } from "../../vault/acl-path";
import { type Frontmatter, serializeNote } from "../../vault/frontmatter";
import { noteExists, writeNoteAtomic } from "../../vault/notes-io";
import { contentHash, normalizeVaultPath, resolveVaultPath } from "../../vault/paths";
import { defineTool } from "../m1/define";
import type { M5Deps } from "./shared";

function splitTags(tags: string | null): string[] {
  return tags
    ? tags
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
    : [];
}

// THE-417: written from each handler's return statement, not from CaptureRow — enqueue_capture and
// commit_capture project only a few of the row's fields, and list_capture_queue derives
// content_preview/tags rather than exposing the raw row.
const EnqueueCaptureOutput = z.object({
  capture_id: z.string(),
  captured_at: z.number(),
  vault: z.string(),
});

const CaptureQueueItem = z.object({
  capture_id: z.string(),
  title: z.string().nullable(),
  content_preview: z.string(),
  tags: z.array(z.string()),
  source: z.string().nullable(),
  captured_at: z.number(),
  target_path_hint: z.string().nullable(),
  committed_at: z.number().nullable(),
  committed_path: z.string().nullable(),
});

const ListCaptureQueueOutput = z.object({
  vault: z.string(),
  items: z.array(CaptureQueueItem),
  next_cursor: z.string().nullable(),
  total_returned: z.number(),
});

const CommitCaptureOutput = z.object({
  capture_id: z.string(),
  target_path: z.string(),
  committed_at: z.number(),
  content_hash: z.string(),
  removed_from_queue: z.boolean(),
});

/** Build a note's frontmatter for commit: capture-derived title/tags, then any
 *  caller overrides on top. Returns null when nothing would be written. */
function commitFrontmatter(
  cap: CaptureRow,
  overrides?: Record<string, unknown>,
): Frontmatter | null {
  const fm: Frontmatter = {};
  if (cap.title) fm.title = cap.title;
  const tags = splitTags(cap.tags);
  if (tags.length > 0) fm.tags = tags;
  if (overrides) for (const [k, v] of Object.entries(overrides)) fm[k] = v;
  return Object.keys(fm).length > 0 ? fm : null;
}

export function buildCaptureTools(deps: M5Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "enqueue_capture",
      description:
        "Stage content in the SQLite capture queue for later commit to the vault (no vault write at enqueue time).",
      inputSchema: z
        .object({
          vault: VaultId,
          content: z.string().min(1),
          title: z.string().optional(),
          tags: z.array(z.string()).optional(),
          source: z.string().optional(),
          target_path_hint: VaultPath.optional(),
          idempotency_key: z.string().min(1).max(128).optional(),
        })
        .strict(),
      outputSchema: EnqueueCaptureOutput,
      requiredScopes: ["write:capture"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const now = (ctx.now ?? Date.now)();
        // THE-572: enqueueCapture is not the single statement it looks like — it INSERTs, then
        // does a separate SELECT to read the row back. Auto-committed, those are two steps: if the
        // read-back threw, the INSERT stood, the claim was released, and a retry enqueued the same
        // content again under a fresh capture id (nothing collides to stop it). One transaction
        // carrying the marker makes the pair atomic.
        const row = inTransaction(ctx.db, () => {
          ctx.markEffectCommitted?.();
          return enqueueCapture(ctx.db, {
            vaultId: v.id,
            content: input.content,
            title: input.title,
            tags: input.tags,
            source: input.source,
            // The hint is normalized for path-safety but never written here.
            targetPathHint: input.target_path_hint
              ? normalizeVaultPath(input.target_path_hint)
              : undefined,
            now,
          });
        });
        return { capture_id: row.id, captured_at: row.captured_at, vault: v.id };
      },
    }),

    defineTool({
      name: "list_capture_queue",
      description:
        "List captures in the queue (pending by default; committed:true lists committed), newest first.",
      inputSchema: z
        .object({
          vault: VaultId,
          committed: z.boolean().default(false),
          source: z.string().optional(),
        })
        .merge(Pagination)
        .strict(),
      outputSchema: ListCaptureQueueOutput,
      requiredScopes: ["read:capture"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const limit = input.limit ?? 100;
        const rows = listCaptures(ctx.db, v.id, {
          committed: input.committed,
          source: input.source,
          afterCursor: input.cursor,
          limit: limit + 1,
        });
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        const next = rows.length > limit && last ? captureCursor(last) : null;
        return {
          vault: v.id,
          items: page.map((r) => ({
            capture_id: r.id,
            title: r.title,
            content_preview: r.content.slice(0, 200),
            tags: splitTags(r.tags),
            source: r.source,
            captured_at: r.captured_at,
            target_path_hint: r.target_path_hint,
            committed_at: r.committed_at,
            committed_path: r.committed_path,
          })),
          next_cursor: next,
          total_returned: page.length,
        };
      },
    }),

    defineTool({
      name: "commit_capture",
      pathAcl: (input) => [{ op: "write", path: input.target_path }],
      description:
        "Write a queued capture to a vault path and mark it committed (or remove it from the queue). Refuses to overwrite an existing note.",
      inputSchema: z
        .object({
          vault: VaultId,
          capture_id: z.string().min(1),
          target_path: VaultPath,
          frontmatter_overrides: z.record(z.string(), z.unknown()).optional(),
          delete_from_queue: z.boolean().default(true),
        })
        .strict(),
      outputSchema: CommitCaptureOutput,
      requiredScopes: ["write:capture"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const cap = getCapture(ctx.db, input.capture_id);
        if (!cap || cap.vault_id !== v.id)
          throw err.invalidInput("capture not found", { capture_id: input.capture_id });
        if (cap.committed_at !== null)
          throw err.invalidInput("capture already committed", { capture_id: input.capture_id });

        const rel = normalizeVaultPath(input.target_path);
        const abs = resolveVaultPath(v.root, rel);
        enforcePathAcl(ctx.acl, "write", rel, v.root);
        if (noteExists(abs).exists) throw err.noteExists("target already exists", { path: rel });

        const content = serializeNote(
          commitFrontmatter(cap, input.frontmatter_overrides),
          cap.content,
        );
        writeNoteAtomic(abs, content, true);
        deps.reindex?.(v.id, rel, content);
        const now = (ctx.now ?? Date.now)();
        if (input.delete_from_queue) deleteCapture(ctx.db, cap.id);
        else markCommitted(ctx.db, cap.id, rel, now);
        return {
          capture_id: cap.id,
          target_path: rel,
          committed_at: now,
          content_hash: contentHash(content),
          removed_from_queue: input.delete_from_queue,
        };
      },
    }),
  ];
}
