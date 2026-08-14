// Domain 11 — Tasks (G2.1). list_tasks and update_task are filesystem-only (they
// parse/edit Markdown task lines via tasks-model and need no plugin); tasks_filter
// proxies the Tasks plugin's own DSL filter through the companion bridge. Reopening
// a long-closed task (done -> open, completed >7d ago) is the one conditional-HITL
// path; ordinary edits are not gated.
import { ElicitToken, err, VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import { paginate } from "../../util/paginate";
import { enforcePathAcl } from "../../vault/acl-path";
import {
  filterBridgeItemsByAcl,
  readableRel,
  readEnumerationUnrestricted,
} from "../../vault/acl-read-filter";
import { requireConfirmation } from "../../vault/hitl";
import { readNote, writeNoteAtomic } from "../../vault/notes-io";
import { contentHash, normalizeVaultPath, resolveVaultPath, walkVault } from "../../vault/paths";
import { defineTool } from "../m1/define";
import { bridgeTimeouts, type M4Deps, openBridgeWithHint } from "./shared";
import {
  applyTaskSet,
  daysSince,
  parseTaskLine,
  serializeTask,
  type TaskFields,
} from "./tasks-model";

const StatusEnum = z.enum(["todo", "done", "cancelled", "in_progress", "scheduled"]);
const PriorityEnum = z.enum(["highest", "high", "medium", "low", "lowest"]);

function matchDue(
  due: string | undefined,
  f: { before?: string; after?: string; on?: string },
): boolean {
  if (!due) return false;
  if (f.on && due !== f.on) return false;
  if (f.before && !(due < f.before)) return false;
  if (f.after && !(due > f.after)) return false;
  return true;
}

// THE-417: mirrors toOutput's fields exactly (below). .passthrough() rather than a plain object:
// toOutput's own return type is annotated Record<string, unknown> (an index signature), so the
// schema needs one too to stay assignable to the handlers' inferred output types.
const TaskItemOutput = z
  .object({
    path: z.string(),
    line: z.number().int(),
    status: StatusEnum,
    description: z.string(),
    tags: z.array(z.string()),
    due: z.string().optional(),
    scheduled: z.string().optional(),
    start: z.string().optional(),
    done: z.string().optional(),
    priority: PriorityEnum.optional(),
    recur: z.string().optional(),
  })
  .passthrough();

function toOutput(t: TaskFields, path: string, line: number): Record<string, unknown> {
  return {
    path,
    line,
    status: t.status,
    description: t.description,
    tags: t.tags,
    ...(t.due ? { due: t.due } : {}),
    ...(t.scheduled ? { scheduled: t.scheduled } : {}),
    ...(t.start ? { start: t.start } : {}),
    ...(t.done ? { done: t.done } : {}),
    ...(t.priority ? { priority: t.priority } : {}),
    ...(t.recur ? { recur: t.recur } : {}),
  };
}

export function buildTasksTools(deps: M4Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "list_tasks",
      domain: "automation",
      description:
        "List tasks across the vault (or a root/paths subset) with typed status/priority/tag/due filters. Filesystem-only; needs no plugin.",
      inputSchema: z
        .object({
          vault: VaultId,
          root: VaultPath.optional(),
          status: z.array(StatusEnum).optional(),
          due: z
            .object({
              before: z.string().optional(),
              after: z.string().optional(),
              on: z.string().optional(),
            })
            .optional(),
          priority: z.array(PriorityEnum).optional(),
          tags: z.array(z.string()).optional(),
          paths: z.array(VaultPath).optional(),
          limit: z.number().int().positive().max(1000).optional(),
          cursor: z.string().optional(),
        })
        .strict(),
      // Mirrors util/paginate's Page<T> shape (items/total/next_cursor, the last present only
      // when a further page remains) with T = TaskItemOutput.
      outputSchema: z.object({
        vault: z.string(),
        items: z.array(TaskItemOutput),
        total: z.number().int(),
        next_cursor: z.string().optional(),
      }),
      requiredScopes: ["read:tasks"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const sub = input.root ? normalizeVaultPath(input.root) : undefined;
        if (sub) enforcePathAcl(ctx.acl, "read", sub, v.root);
        const rels = input.paths?.length
          ? input.paths.map(normalizeVaultPath)
          : walkVault(v.root, { sub, extensions: [".md"] }).map((e) => e.relPath);
        const wantTags = input.tags?.map((t) => (t.startsWith("#") ? t : `#${t}`));

        const items: Record<string, unknown>[] = [];
        for (const rel of rels) {
          if (!readableRel(ctx.acl, rel)) continue;
          if (sub && !(rel === sub || rel.startsWith(`${sub}/`))) continue;
          let raw: string;
          try {
            raw = readNote(resolveVaultPath(v.root, rel)).raw;
          } catch {
            continue;
          }
          const lines = raw.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            const t = parseTaskLine(lines[i] ?? "");
            if (!t) continue;
            if (input.status && !input.status.includes(t.status)) continue;
            if (input.priority && (!t.priority || !input.priority.includes(t.priority))) continue;
            if (wantTags && !wantTags.every((tag) => t.tags.includes(tag))) continue;
            if (input.due && !matchDue(t.due, input.due)) continue;
            items.push(toOutput(t, rel, i + 1));
          }
        }
        return { vault: v.id, ...paginate(items, input.limit, input.cursor) };
      },
    }),

    defineTool({
      name: "update_task",
      domain: "automation",
      vaultArg: "vault",
      pathAcl: (input) => [{ op: "write", path: input.path }],
      description:
        "Modify a task in place by line number (status, dates, priority, tags). Reopening a task completed more than 7 days ago requires confirmation.",
      inputSchema: z
        .object({
          vault: VaultId,
          path: VaultPath,
          line: z.number().int().positive(),
          set: z
            .object({
              status: StatusEnum.optional(),
              description: z.string().optional(),
              due: z.string().optional(),
              scheduled: z.string().optional(),
              start: z.string().optional(),
              done: z.string().optional(),
              priority: PriorityEnum.optional(),
              recur: z.string().optional(),
              add_tags: z.array(z.string()).optional(),
              remove_tags: z.array(z.string()).optional(),
            })
            .strict()
            .optional(),
          // THE-824: advertised so a caller can discover the HITL confirmation parameter via
          // describe_capability — stripped off rawArgs into ctx.elicitToken before this schema
          // ever validates it (mcp/server.ts), so declaring it here changes nothing about dispatch.
          elicit_token: ElicitToken.optional(),
        })
        .strict(),
      // Note: no `vault` field — update_task's return omits it (unlike every other M4 tool here).
      outputSchema: z.object({
        path: z.string(),
        line: z.number().int(),
        updated_at: z.string(),
        prev_state: TaskItemOutput,
        new_state: TaskItemOutput,
        content_hash: z.string(),
      }),
      requiredScopes: ["write:tasks"],
      // THE-824: display-only — see ToolDefinition.conditionallyDestructive. The real gate stays
      // the requireConfirmation call below (reopeningStale); this only stops the wire annotation
      // from advertising destructive: false for a tool that CAN demand confirmation.
      conditionallyDestructive: true,
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        enforcePathAcl(ctx.acl, "write", rel, v.root);
        const abs = resolveVaultPath(v.root, rel);
        let raw: string;
        try {
          raw = readNote(abs).raw;
        } catch {
          throw err.noteNotFound("note not found", { path: rel });
        }
        const eol = raw.includes("\r\n") ? "\r\n" : "\n";
        const lines = raw.split(/\r?\n/);
        const idx = input.line - 1;
        const original = lines[idx];
        const parsed = original !== undefined ? parseTaskLine(original) : null;
        if (!parsed) throw err.invalidInput("line is not a task", { path: rel, line: input.line });

        const set = input.set ?? {};
        const now = (ctx.now ?? Date.now)();
        const reopeningStale =
          parsed.status === "done" &&
          set.status !== undefined &&
          set.status !== "done" &&
          parsed.done !== undefined &&
          daysSince(parsed.done, now) > 7;
        requireConfirmation(ctx, "update_task", input, reopeningStale, {
          path: rel,
          line: input.line,
        });

        const updated = applyTaskSet(parsed, set);
        lines[idx] = serializeTask(updated);
        const content = lines.join(eol);
        writeNoteAtomic(abs, content);
        deps.reindex?.(v.id, rel, content);
        return {
          path: rel,
          line: input.line,
          updated_at: new Date(now).toISOString(),
          prev_state: toOutput(parsed, rel, input.line),
          new_state: toOutput(updated, rel, input.line),
          content_hash: contentHash(content),
        };
      },
    }),

    defineTool({
      name: "tasks_filter",
      domain: "automation",
      description:
        "Run a Tasks-plugin filter expression (its DSL) via the companion bridge, with optional grouping/sorting. Requires the Tasks plugin; if it is unavailable, use list_tasks for native status/priority/tag/due filtering.",
      inputSchema: z
        .object({
          vault: VaultId,
          filter: z.string().min(1),
          group_by: z.string().optional(),
          sort_by: z.string().optional(),
          limit: z.number().int().positive().max(1000).optional(),
          cursor: z.string().optional(),
        })
        .strict(),
      // items/total are ALWAYS the ACL-filtered, recomputed values (overriding whatever raw
      // items/total the bridge sent); under a read whitelist the raw `...result` siblings
      // (e.g. `groups`) are dropped entirely (THE-270) — passthrough covers them when present.
      outputSchema: z
        .object({ vault: z.string(), items: z.array(z.unknown()), total: z.number().int() })
        .passthrough(),
      requiredScopes: ["read:tasks"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const { client } = openBridgeWithHint(
          deps,
          v.id,
          "tasks",
          "the Tasks community plugin is required for tasks_filter's query DSL; for native status/priority/tag/due filtering without it, use the list_tasks tool.",
        );
        const result = await client.request<Record<string, unknown>>({
          method: "POST",
          path: "/tasks/filter",
          body: {
            filter: input.filter,
            ...(input.group_by ? { group_by: input.group_by } : {}),
            ...(input.sort_by ? { sort_by: input.sort_by } : {}),
            ...(input.limit ? { limit: input.limit } : {}),
            ...(input.cursor ? { cursor: input.cursor } : {}),
          },
          plugin: "tasks",
          timeoutMs: bridgeTimeouts(deps, v.id).timeoutMs,
        });
        // Intersect bridge-enumerated tasks with the read ACL; fail closed on an
        // unattributable row when a read whitelist is configured (D2/B1). `groups`
        // (aggregate counts) pass through untouched.
        const rawItems = Array.isArray(result.items) ? (result.items as unknown[]) : [];
        const items = filterBridgeItemsByAcl(ctx.acl, rawItems, { tool: "tasks_filter" });
        // Under a read whitelist, drop `...result` — `groups` (and any other sibling) is computed
        // over the UNFILTERED task set and leaks counts of notes outside the whitelist (THE-270).
        if (!readEnumerationUnrestricted(ctx.acl))
          return { vault: v.id, items, total: items.length };
        return { vault: v.id, ...result, items, total: items.length };
      },
    }),
  ];
}
