// THE-633 — the stated-goals verbs, split out of experiential-tools.ts.
//
// Split for the same reason doctor/entrypoints.ts was: experiential-tools.ts sits at the 700-line
// ceiling the structural-refactor program set, and biome's noExcessiveLinesPerFile rejects the
// append. The tools stay in the m8 domain and are composed back in by buildExperientialTools.
import { randomUUID } from "node:crypto";
import { VaultId } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import { closeGoal, listGoals, setGoal } from "../../experiential/goals";
import type { ToolDefinition } from "../../mcp/registry";
import { defineTool } from "../m1/define";
import { availableWith, type M8Deps, UNAVAILABLE } from "./shared";

export function buildGoalTools(deps: M8Deps): ToolDefinition[] {
  return [
    // ---- THE-633: stated goals ----
    //
    // Three verbs, no fourth. There is deliberately NO update_goal and NO reopen: the decision's
    // authority-monotonicity constraint means a goal moves open -> terminal exactly once, and a verb
    // that mutated an existing goal would be the low-confidence write path the whole design excludes.
    // Provenance is hard-coded 'stated' in the store and CHECK-pinned in the migration, so an
    // inferred write is a constraint violation rather than a convention.
    defineTool({
      name: "set_goal",
      domain: "knowledge",
      description:
        "Record a STATED goal for a vault — what the user is trying to accomplish, as distinct from a learned preference (a preference is 'you tend to X' and never resolves; a goal is 'you intend to X' and ends in completed/abandoned/expired). Goals are stated by the user and never inferred: nothing in the reflect/extract path can write one. An optional target_date lets the expiry sweep mark it 'expired' rather than leaving stale intent to bias later reads.",
      inputSchema: z
        .object({
          vault: VaultId,
          text: z.string().min(1).max(2000),
          target_date: z.number().int().positive().optional(),
        })
        .strict(),
      vaultArg: "vault",
      outputSchema: availableWith({
        id: z.string(),
        vault: z.string(),
        text: z.string(),
        status: z.string(),
        created_at: z.number(),
        target_date: z.number().nullable(),
      }),
      requiredScopes: ["write:workspace"],
      tags: ["experiential"],
      handler: (input) => {
        if (!deps.edb) return UNAVAILABLE;
        const now = Date.now();
        const row = setGoal(deps.edb, {
          id: randomUUID(),
          vaultId: input.vault,
          text: input.text,
          createdAt: now,
          ...(input.target_date !== undefined ? { targetDate: input.target_date } : {}),
        });
        return {
          available: true as const,
          id: row.id,
          vault: row.vault_id,
          text: row.text,
          status: row.status,
          created_at: row.created_at,
          target_date: row.target_date,
        };
      },
    }),

    defineTool({
      name: "list_goals",
      domain: "knowledge",
      description:
        "List a vault's stated goals, newest first. Defaults to OPEN goals only — a consumer that forgets to filter should see current intent rather than a graveyard of closed ones. Pass status to narrow to a terminal state, or 'any' for the full history. 'expired' (the deadline sweep's verdict) and 'abandoned' (the user's) are deliberately distinct and must not be counted together.",
      inputSchema: z
        .object({
          vault: VaultId,
          status: z.enum(["open", "completed", "abandoned", "expired", "any"]).default("open"),
          limit: z.number().int().positive().max(200).default(50),
        })
        .strict(),
      vaultArg: "vault",
      outputSchema: availableWith({
        vault: z.string(),
        count: z.number().int(),
        goals: z.array(
          z.object({
            id: z.string(),
            text: z.string(),
            status: z.string(),
            source: z.string(),
            created_at: z.number(),
            target_date: z.number().nullable(),
            closed_at: z.number().nullable(),
          }),
        ),
      }),
      requiredScopes: ["read:notes"],
      tags: ["experiential", "knowledge"],
      handler: (input) => {
        if (!deps.edb) return UNAVAILABLE;
        const rows = listGoals(deps.edb, input.vault, {
          status: input.status,
          limit: input.limit,
        });
        return {
          available: true as const,
          vault: input.vault,
          count: rows.length,
          goals: rows.map((r) => ({
            id: r.id,
            text: r.text,
            status: r.status,
            source: r.source,
            created_at: r.created_at,
            target_date: r.target_date,
            closed_at: r.closed_at,
          })),
        };
      },
    }),

    defineTool({
      name: "close_goal",
      domain: "knowledge",
      description:
        "Close a stated goal into a terminal state: completed or abandoned. Once-only — a second close reports closed:false rather than silently succeeding, and there is no reopen verb, because a system that quietly reopened a goal the user completed is exactly the low-confidence mutation this plane forbids. 'expired' is not settable here; it is the deadline sweep's verdict alone.",
      inputSchema: z
        .object({
          vault: VaultId,
          id: z.string().min(1),
          status: z.enum(["completed", "abandoned"]),
        })
        .strict(),
      vaultArg: "vault",
      outputSchema: availableWith({
        closed: z.boolean(),
        id: z.string(),
        status: z.string().nullable(),
        closed_at: z.number().nullable(),
      }),
      requiredScopes: ["write:workspace"],
      tags: ["experiential"],
      handler: (input) => {
        if (!deps.edb) return UNAVAILABLE;
        const row = closeGoal(deps.edb, {
          id: input.id,
          vaultId: input.vault,
          status: input.status,
          closedAt: Date.now(),
        });
        // null covers BOTH "no such goal in this vault" and "already closed". Reported as
        // closed:false rather than an error: neither is exceptional, and the caller needs to be able
        // to tell that nothing happened.
        return {
          available: true as const,
          closed: row !== null,
          id: input.id,
          status: row?.status ?? null,
          closed_at: row?.closed_at ?? null,
        };
      },
    }),
  ];
}
