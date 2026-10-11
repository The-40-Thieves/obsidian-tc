// The STAMPING verbs — the two tools that write a judgement onto evidence the store already
// holds. Everything in experiential-tools.ts reads or inspects; these two write an opinion.
//
// Split out for the reason goal-tools.ts was: experiential-tools.ts sits at the 700-line ceiling
// and biome's noExcessiveLinesPerFile rejects an append. `record_retrieval_feedback` moved here
// with `work_result` rather than being left behind, because the boundary that buys the room is
// also the better one: the two verbs share a shape (stamp -1|0|+1 onto rows the caller already
// produced), a scope (`write:workspace`), and a failure mode (adoption — THE-718's sat at 0 of 97
// for its whole life, which is exactly the risk THE-726 was written to break). Both stay in the m8
// domain and are composed back in by buildExperientialTools.
//
// They judge DIFFERENT things and the descriptions say so, because conflating them is what
// THE-718 had to undo: `record_retrieval_feedback` judges a RETRIEVAL ("was this the right chunk
// for that query"), `work_result` judges the TASK ("did the work go well").
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import { inTransaction } from "../../db/txn";
import { stampOpenWindow } from "../../experiential/verdict";
import type { ToolDefinition } from "../../mcp/registry";
import { activeSessionFor } from "../../workspace/sessions";
import { defineTool } from "../m1/define";
import { stampRetrievalFeedback } from "./feedback-scope";
import { availableWith, type M8Deps, UNAVAILABLE } from "./shared";

// #1229: one call may stamp a batch. No shared batch-size constant exists in the repo (the other
// list caps are inline literals), so this tool owns its cap. It bounds one transaction's write set.
const MAX_VERDICTS = 50;

const Verdict = z
  .object({
    chunk_id: z.string().min(1),
    feedback: z.number().int().min(-1).max(1),
  })
  .strict();

const NoopReason = z.enum(["session_scope", "no_owned_retrievals"]);

// #1229: the two forms are each optional in the published schema, because a root oneOf/anyOf is
// banned (test/schema-portability-rules.ts). Exactly one of them is enforced here instead.
function refineVerdictForm(
  i: { chunk_id?: string; feedback?: number; verdicts?: unknown[] },
  ctx: z.RefinementCtx,
): void {
  const single = i.chunk_id !== undefined || i.feedback !== undefined;
  const batch = i.verdicts !== undefined;
  if (single && batch)
    ctx.addIssue({
      code: "custom",
      message:
        "send either chunk_id + feedback (one chunk) or verdicts (a batch of chunks), not both",
    });
  else if (!single && !batch)
    ctx.addIssue({
      code: "custom",
      message: `send chunk_id + feedback to stamp one chunk, or verdicts: [{chunk_id, feedback}, ...] (1-${MAX_VERDICTS} items) to stamp a batch`,
    });
  else if (single && (i.chunk_id === undefined || i.feedback === undefined))
    ctx.addIssue({
      code: "custom",
      message:
        "the single form needs both chunk_id and feedback (chunk_id + feedback); for several chunks send verdicts instead",
    });
}

export function buildVerdictTools(deps: M8Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "record_retrieval_feedback",
      principalOwned: true,
      domain: "knowledge",
      // THE-718: the description leads with WHEN to call this, because the emitter decision landed
      // on "the acting agent stamps it" and a tool description is the only affordance an MCP
      // client sees. The previous text opened on storage mechanics and spent most of its length on
      // an authorization model the caller cannot act on, so it told an agent what the tool DOES
      // and never that it was expected to use it. Adoption is this signal's only failure mode —
      // it sat at 0 stamps across 97 retrieval events — so the trigger comes first and the ACL
      // detail is compressed to the part a caller can actually respond to.
      description:
        "Report which retrieved chunks actually helped. CALL THIS after you act on a search result: feedback (-1|0|+1) = was this the right chunk to return for that query. Stamp the chunks you genuinely used, not every hit, and stamp -1 when a confidently-returned chunk was wrong — a negative is worth more than silence. This is the only signal separating a chunk that gets RETRIEVED from one that gets USED: it feeds the ACT-R activation recompute, so stamping is what makes later retrieval better, and not stamping leaves ranking blind. Judge the RETRIEVAL, not your task: whether the task went well is a different question this tool deliberately no longer accepts. Several chunks at once: send verdicts: [{chunk_id, feedback}, ...] (1-50 items), applied in one transaction. Otherwise send chunk_id + feedback for one chunk. Send one form or the other, never both. Each target is your most recent retrieval event(s) for that chunk (last_n, default 1, applies to every item). Returns `updated`; when that is 0 it also returns `reason` — `session_scope` (you own retrievals for this chunk, none in the current scope) or `no_owned_retrievals` (nothing of yours matches), so a no-op is never silent. A batch returns `results`, one {chunk_id, updated, reason?} per verdict. You may only stamp retrievals your own caller produced; an unidentified caller cannot stamp, and admin:workspace crosses both that and the session scope.",
      // THE-718: `outcome` is gone, not deprecated. It asked a TASK-level question ("did acting on
      // this lead somewhere good") of a RESPONSE-level row, so one task's verdict was attributed to
      // every chunk the search happened to return — an estimand with no denominator. Under `.strict()`
      // a caller still passing `outcome` gets a hard rejection instead of a silent drop; that is
      // deliberate, and safe — the column recorded 0 stamps in its lifetime.
      // #1229: the single form stays `chunk_id` + `feedback`; `verdicts` is the batch form. Both are
      // optional at the schema level and refineVerdictForm makes exactly one of them required.
      inputSchema: z
        .object({
          chunk_id: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Single form: the chunk to stamp. Send chunk_id + feedback together, or verdicts, never both.",
            ),
          feedback: z
            .number()
            .int()
            .min(-1)
            .max(1)
            .optional()
            .describe("Single form: -1, 0 or +1 for chunk_id. Send it with chunk_id."),
          verdicts: z
            .array(Verdict)
            .min(1)
            .max(MAX_VERDICTS)
            .optional()
            .describe(
              `Batch form (1-${MAX_VERDICTS} items): one {chunk_id, feedback} per chunk, all applied in one transaction. Send verdicts OR chunk_id + feedback, never both.`,
            ),
          session_id: z
            .string()
            .optional()
            .describe("Session scope for the stamp. Applies to every verdict in a batch."),
          last_n: z
            .number()
            .int()
            .positive()
            .max(50)
            .default(1)
            .describe(
              "How many of each chunk's most recent retrievals to stamp (default 1). Applies to every verdict in a batch.",
            ),
        })
        .strict()
        .superRefine(refineVerdictForm),
      outputSchema: availableWith({
        // Single form: chunk_id + updated (+ reason when nothing was written). Batch form: results.
        // THE-718: `updated: 0` is otherwise indistinguishable from a successful stamp, and in
        // production it was 100% of calls. Present only when nothing was written.
        chunk_id: z.string().optional(),
        updated: z.number().int().optional(),
        reason: NoopReason.optional(),
        results: z
          .array(
            z.object({
              chunk_id: z.string(),
              updated: z.number().int(),
              reason: NoopReason.optional(),
            }),
          )
          .optional(),
      }),
      requiredScopes: ["write:workspace"],
      tags: ["experiential"],
      handler: (input, ctx) => {
        if (!deps.edb) return UNAVAILABLE;
        const edb = deps.edb;
        const scope = { session_id: input.session_id, last_n: input.last_n };
        const { verdicts } = input;
        if (verdicts !== undefined) {
          // #1229: every item runs through the single form's own stampRetrievalFeedback, so the
          // ownership and session checks are the same code, not a copy. One transaction makes the
          // batch all-or-nothing: a caller-level refusal thrown by any item rolls back the rest.
          const results = inTransaction(edb, () =>
            verdicts.map((v) => {
              const r = stampRetrievalFeedback(
                edb,
                { chunk_id: v.chunk_id, feedback: v.feedback, ...scope },
                ctx,
              );
              return {
                chunk_id: r.chunk_id,
                updated: r.updated,
                ...(r.reason ? { reason: r.reason } : {}),
              };
            }),
          );
          return { available: true as const, results };
        }
        const { chunk_id, feedback } = input;
        // refineVerdictForm guarantees both on this branch. The throw keeps the type honest for a
        // caller that reaches the handler without going through schema validation.
        if (chunk_id === undefined || feedback === undefined)
          throw err.invalidInput("send chunk_id + feedback, or verdicts for a batch");
        return stampRetrievalFeedback(edb, { chunk_id, feedback, ...scope }, ctx);
      },
    }),

    defineTool({
      name: "work_result",
      principalOwned: true,
      domain: "knowledge",
      description:
        "Record how the task you just finished went, as -1 (it failed or produced a bad result), 0 (neutral) or +1 (it worked). The verdict applies to every judgeable tool call in your current session that has no verdict yet, and then a fresh window opens — so calling this once at the end of a session covers the session, and calling it after each task partitions the session into those tasks. Protocol traffic and this verb itself are never judged. Nothing else writes agent_episodes.task_result, and two retrieval behaviours read it: a -1 holds those episodes out of promotion, and the preference extractor only ever learns from episodes carrying a verdict.",
      inputSchema: z
        .object({
          result: z
            .union([z.literal(-1), z.literal(0), z.literal(1)])
            .describe("-1 bad, 0 neutral, +1 good."),
          as_of: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "Epoch ms ceiling: only calls at or before this are judged. Defaults to now. Use it when work continued while you were deciding — the server cannot observe your task boundary and will otherwise sweep in anything committed before this call landed.",
            ),
        })
        .strict(),
      outputSchema: availableWith({
        stamped: z.number(),
        demoted: z.number(),
        session_id: z.string(),
        verdict_at: z.number(),
      }),
      requiredScopes: ["write:workspace"],
      // THE-839: this tag is what makes the verb's own dispatch row `episode_type = 'verdict'`, so
      // it is excluded from the very window it stamps. Without it every call would strand its own
      // episode — captured AFTER the handler returns — reopening the window on every stamp and
      // leaving the debt queue permanently non-empty.
      tags: ["experiential", "verdict"],
      handler: (input, ctx) => {
        if (!deps.edb) return UNAVAILABLE;

        // No session_id input, deliberately. `activeSessionFor` resolves the caller's OWN open
        // session from the server-observed principal, never a caller-declared value — so the
        // cross-principal hole THE-838 closed on `end_session` cannot exist here by construction
        // rather than by a guard someone has to remember. A caller cannot name a session it does
        // not own because it cannot name one at all.
        // THE-1108: same resolver bound the HTTP dispatch context uses — a principal whose only
        // "open" session is a forgotten start_session past windowSeconds gets treated as having
        // none, same as every other activeSessionFor call site.
        const active = activeSessionFor(ctx.db, ctx.caller, {
          windowSeconds: deps.sessions?.windowSeconds,
        });
        if (!active) {
          // THROWS rather than returning the degraded `available: false` envelope. Those are
          // different conditions and conflating them costs the caller the one thing it needs: the
          // envelope means "this server cannot do this at all" (the experiential store is closed),
          // and there is nothing to retry. This is "you have no open session", which the caller can
          // fix in one call. Never a silent no-op either way — this epic exists because writers that
          // were registered and correct sat behind nothing calling them.
          throw err.invalidInput("no open session for this principal", {
            hint: "call start_session first, or let the server open one implicitly on your next vault call",
          });
        }

        const now = (ctx.now ?? Date.now)();
        // Clamp only the UPPER bound. An `as_of` in the future would sweep in work that, from this
        // verdict's point of view, has not happened.
        //
        // There is deliberately NO lower clamp. An earlier version raised `as_of` to the session's
        // earliest episode, which silently rewrote the caller's stated boundary into a different
        // one: asking for `as_of=500` when the first episode is at 1000 means "judge nothing", and
        // answering it by stamping that first episode is a worse failure than stamping zero rows.
        // An empty window is already a legitimate, reportable outcome (`stamped: 0`), so the honest
        // response to a boundary below all the work is exactly that.
        const asOf = Math.min(input.as_of ?? now, now);

        const out = stampOpenWindow(deps.edb, {
          sessionId: active.sessionId,
          result: input.result,
          now,
          asOf,
          // THE-726: a first-person judgement, never the derived writer's kind. No policy — there
          // is no rule to version, the operator IS the judgement.
          source: "operator",
        });
        return {
          available: true as const,
          stamped: out.stamped,
          demoted: out.demoted,
          session_id: active.sessionId,
          verdict_at: out.verdictAt,
        };
      },
    }),
  ];
}
