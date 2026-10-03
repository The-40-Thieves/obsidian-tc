// THE-1106 (GH #967 parts 1/3) fix round 1: split out of mcp/server.ts (biome's 700-line
// noExcessiveLinesPerFile), mirroring error-rendering.ts's own split for the same reason.
//
// This module used to also hand-roll a server-initiated `elicitation/create` round trip for
// stdio. That was WRONG: the installed `@modelcontextprotocol/server@2.2.0`'s low-level `Server`
// class (what createMcpServer builds) already does this for any `inputRequired` a handler returns
// on a 2025-era connection, via a DEFAULT-ON `LegacyInputRequiredShim`
// (`Server._wrapHandler("tools/call", ...)` -> `_invokeInputRequiredCapableHandler` ->
// `_legacyInputRequiredShim().fulfill(...)`, `dist/mcp-*.mjs` ~L1124/1184/1205-1206, `legacyShim:
// options?.legacyShim ?? true` at construction ~L801). THE-1133: re-traced against 2.2.0's dist —
// this block is byte-for-byte IDENTICAL to 2.0.0's (diffed both `mcp-*.mjs` files at these spans);
// only the line numbers moved, pushed down by unrelated additions earlier in the same file (OAuth
// scope challenges, the Streamable HTTP body-size limit, SEP-2243 header validation). The shim
// sends the elicitation/create legs itself (gated by the SAME bare-`{}`-means-form rule as below),
// with a human-paced 600s per-leg timeout, `relatedRequestId`, and abort-linking to the outer
// request, then re-enters the SAME handler with the verified `requestState`. Verified by tracing
// the installed package's source (not assumed) and by test/hitl-legacy-shim-elicitation.test.ts.
import {
  type CallToolResult,
  inputRequired,
  inputResponse,
  type Server,
} from "@modelcontextprotocol/server";
import { type ErrorJSON, err, type MorgianaEventData } from "@the-40-thieves/obsidian-tc-shared";
import type { ElicitCodec, ElicitRequestState } from "../elicit-request-state";
import { type HitlSource, recordHitlOffer } from "../hitl-telemetry";
import { callerHash } from "../throttle";
import { mintCommandFromDetails } from "./elicit-command";
// THE-1106 fix round 1 (check:duplicate-exports): reuse tasks.ts's copy rather than declaring a
// second one — this module and tasks.ts independently needed the SAME SEP-2575 fact.
import type { CallerContext } from "./registry";
import { MODERN_PROTOCOL_VERSION } from "./tasks";

/**
 * Whether the NATIVE (modern-era) `inputRequired` round trip will reach the client, read from TWO
 * sources: `isModern` (`opts.era === "modern"`, the only signal for HTTP's stateless per-request
 * construction — `server.getNegotiatedProtocolVersion()` is `undefined` there, no real
 * `initialize` ever runs on that ephemeral instance) OR `server.getNegotiatedProtocolVersion()`
 * reporting 2026-07-28+ (the only signal for a long-lived connection, e.g. stdio, that negotiated
 * modern the honest way — nothing stops a stdio client calling `server/discover`, always
 * registered, and `createMcpHandler`'s modern-route handling calls `setNegotiatedProtocolVersion`
 * before invoking a handler, so the accessor is authoritative once a real negotiation happened).
 */
export function negotiatedModern(server: Server, isModern: boolean): boolean {
  if (isModern) return true;
  const negotiated = server.getNegotiatedProtocolVersion();
  return negotiated !== undefined && negotiated >= MODERN_PROTOCOL_VERSION;
}

/** Confirmation telemetry label (hitl-telemetry.ts): `request_state` for the 2026-era client echo,
 *  `form` for the server-driven legacy round trip. */
export function hitlFormSource(server: Server, isModern: boolean): "form" | "request_state" {
  return negotiatedModern(server, isModern) ? "request_state" : "form";
}

/**
 * Whether an `inputRequired` handler return will ACTUALLY be delivered for this request — the
 * fail-closed gate `dispatchToResult` uses before offering the HITL round trip at all. TRUE for
 * either delivery path: native modern handling (`negotiatedModern`), or the legacy shim —
 * STDIO-ONLY, opted into per-instance (`legacyElicitationShim === true`; `false`/absent on every
 * HTTP-served server, so a legacy-era HTTP session takes neither path). `createMcpServer` passes
 * this SAME `legacyElicitationShim` value as `inputRequired: { legacyShim: ... }` at construction
 * (an explicit `true`/`false`, never the SDK's own bundled default in either direction — see the
 * `Server` constructor call site) — so `legacyElicitationShim === true` here is not a GUESS about
 * the shim's state, it is the value this function's own caller used to configure it. Not a
 * SECURITY gate either way — `checkHitl` only ever accepts a verified `requestState` (itself now
 * also checked against the confirm leg's OWN accept/decline answer — see mcp/server.ts's
 * `confirmApproved`) or a single-use token — a wrong answer here degrades to the plain
 * `elicit_required` text error rather than to a broken shape. Server-initiated legs over
 * Streamable HTTP are unverified against real clients and explicitly out of scope, which is why
 * the legacy half is opt-in and stdio-only.
 */
export function roundTripDeliverable(
  server: Server,
  isModern: boolean,
  legacyElicitationShim: boolean | undefined,
): boolean {
  return negotiatedModern(server, isModern) || legacyElicitationShim === true;
}

export function clientSupportsFormElicitation(caps: unknown): boolean {
  if (caps === null || typeof caps !== "object") return false;
  const elicitation = (caps as Record<string, unknown>).elicitation;
  if (elicitation === null || typeof elicitation !== "object") return false;
  const e = elicitation as Record<string, unknown>;
  if ("form" in e) return true;
  if ("url" in e) return false;
  return true; // bare `{}` — implied form support (2025 pre-mode meaning)
}

/**
 * THE-1106 fix round 2 (Opus M2, cross-vendor review — 3rd pass): `path` (and, defensively,
 * `tool`) arrive here as UNTRUSTED display text — a vault-relative `VaultPath` only rejects `..`
 * and an absolute leading slash, so it may legally contain newlines, backticks, double quotes, or
 * arbitrary prose. Left unsanitized, a crafted path can inject a fake extra "line" into a rendered
 * form message or directive sentence — e.g. a path ending the sentence and appending its own
 * spoofed `confirm with: obsidian-tc elicit ...` line, or a bogus "this is a harmless preview"
 * reassurance — that a human skimming the text, or a naive line-based locator, could mistake for
 * the real one.
 *
 * The 2nd-pass fix (`[\x00-\x1f\x7f\``]`, plus `JSON.stringify` quoting) MISSED three classes
 * `JSON.stringify` does NOT escape and that render as line breaks or invisible reordering in a
 * terminal/UI even INSIDE a JSON string literal: U+0085 (NEL), U+2028/U+2029 (LINE/PARAGRAPH
 * SEPARATOR — measured: a path containing U+2028 produced 4 rendered lines and 2 `confirm with:`
 * lines), and the bidi control range (U+202A-U+202E, U+2066-U+2069 — RLO/LRO/PDF and friends,
 * which can make displayed text read in an order that does not match its bytes, independent of
 * line-splitting). `\p{Cc}` (control) + `\p{Cf}` (format — covers NEL and every bidi control) +
 * `\p{Zl}`/`\p{Zp}` (the two Unicode line/paragraph separators) is the closed set that actually
 * covers "characters that can make rendered text lie about its own structure," not an enumerated
 * guess at which ones matter. Caps length so a pathologically long value cannot crowd out the real
 * instruction. `JSON.stringify` quoting on TOP of this still matters for every character this does
 * NOT strip (letters, digits, ordinary punctuation) — the claim is "no character can forge the
 * QUOTING," not "no character needs stripping first."
 */
export function sanitizeDisplayText(value: string, maxLen = 200): string {
  const stripped = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}`]/gu, "");
  return stripped.length > maxLen ? `${stripped.slice(0, maxLen)}…` : stripped;
}

/**
 * The confirmation form the `inputRequired` round trip sends, on EITHER era (native modern
 * handling, or the legacy shim above) — ONE builder so the message text and `approve: boolean`
 * schema cannot drift between them. `path`, when given, names the call's target (e.g. the note
 * being overwritten/deleted/moved) so the human approving it can see WHAT before approving;
 * omitted when the triggering error carried none (e.g. the always-on `destructive: true` dispatch
 * gate, which has no `proposed` object to source a path from — see policy-gates.ts). Rendered as a
 * `JSON.stringify`d literal AFTER `sanitizeDisplayText` strips control/format/line-separator
 * characters and the backtick: the quoting itself (the `"..."` delimiters) cannot be forged by any
 * character the SANITIZED value still contains, and the characters that could otherwise make the
 * rendered text lie about its own line structure (real newlines, U+2028/2029, bidi controls) are
 * removed before quoting even runs — `JSON.stringify` alone was not sufficient, since it does not
 * escape those.
 */
export function buildConfirmElicitationParams(
  name: string,
  path?: string,
): {
  mode: "form";
  message: string;
  requestedSchema: {
    type: "object";
    properties: { approve: { type: "boolean"; title: string } };
    required: ["approve"];
  };
} {
  // THE-1106 fix round 2 (Opus M2): `tool` is quoted the SAME way `path` is — JSON.stringify after
  // sanitizeDisplayText — even though it is registry-derived, never caller data, purely for
  // defense in depth and so the message never mixes an unquoted vs a quoted untrusted field.
  const safeName = JSON.stringify(sanitizeDisplayText(name));
  const target =
    path !== undefined ? ` (target: ${JSON.stringify(sanitizeDisplayText(path))})` : "";
  return {
    mode: "form",
    message: `Confirm ${safeName}: this call changes vault content and needs approval${target}.`,
    requestedSchema: {
      type: "object",
      properties: {
        approve: { type: "boolean", title: "Approve this change" },
      },
      required: ["approve"],
    },
  };
}

/** How a non-approving confirm leg ended: `cancelled` = dismissed without choosing, `declined` = a no. */
export type ConfirmRoundOutcome = "declined" | "cancelled";

/**
 * THE-1106 fix round 1 (CRITICAL — cross-vendor review, found empirically by the shim wire test,
 * not by inspection): a verified `requestState` alone proves the token is AUTHENTIC and bound to
 * THIS call — it says NOTHING about whether the human actually approved. The SDK's legacy shim
 * (and, on the wire, a resubmitting modern client) re-enters the handler with the SAME verified
 * requestState after EVERY leg outcome — accept, decline, OR cancel — because minting
 * `requestState` happens BEFORE the leg is even asked. Before this fix, an echoed state alone was
 * enough to satisfy `checkHitl`/`hitlSatisfiedByState`, so a DECLINED confirmation still completed
 * the call — reproduced directly: a `destructive: true` tool call, answered `{action: "decline"}`
 * on the `elicitation/create` leg, still wrote. Fixed to require the confirm leg's ACTUAL response
 * (`inputResponse`, the SDK's own discriminated reader for `ctx.mcpReq.inputResponses`, untrusted
 * client content) to be `{action: "accept", content: {approve: true}}` before trusting the echoed
 * state — returned as `elicitState`, `undefined` otherwise.
 *
 * `roundOutcome` is set when a round happened for THIS wire request AND it was NOT an approval —
 * `"cancelled"` for the client's `cancel` action (dismissed without choosing: approval was NOT
 * OBTAINED, the human never said no), `"declined"` for anything else (an explicit `decline`, or
 * `accept` without `approve: true`). `dispatchToResult` uses it to stop offering a SECOND
 * `inputRequired` for the SAME answered confirmation, which would otherwise loop (the re-thrown
 * `elicit_required` looks identical to a first attempt), and to render the matching text. Deliberately NOT triggered by an approved-but-mismatched state
 * (e.g. one minted for different arguments, a different vault, or one whose GATE doesn't cover
 * what actually needed confirming — a handler-side gate the dispatch-level state doesn't reach) —
 * that case gets its OWN fresh round trip rather than a suppressed error, capped by `approvedRound`
 * below rather than by `roundOutcome`.
 *
 * `approvedRound` surfaces the echoed state's OWN `round` counter whenever the leg was approved
 * (matched or not) — `offerInputRequired` uses it to cap re-offers after a run of
 * approved-but-mismatched rounds to a SMALL number, not the SDK shim's full `maxRounds` (8), so a
 * persistent gate mismatch cannot prompt a human eight times for what looks like one call.
 */
export function resolveElicitConfirmation(mcpReq: {
  requestState?: <T>() => T | undefined;
  inputResponses?: Record<string, unknown>;
}): {
  elicitState: ElicitRequestState | undefined;
  roundOutcome: ConfirmRoundOutcome | undefined;
  approvedRound: number | undefined;
  /** What the human answered on this request's confirm leg, tied to the verified echoed state's
   *  own tool/args_hash. Telemetry only (hitl-telemetry.ts): no gate reads it. Undefined with no
   *  verified state or no answer, so an unverifiable claim is never recorded. */
  answer:
    | { action: "accept" | "decline" | "cancel"; tool: string; argsHash: string; vaultId: string }
    | undefined;
} {
  const echoed = mcpReq.requestState?.<ElicitRequestState>();
  const confirmResponse = inputResponse(mcpReq.inputResponses, "confirm");
  const confirmApproved =
    confirmResponse.kind === "elicit" &&
    confirmResponse.action === "accept" &&
    confirmResponse.content?.approve === true;
  return {
    elicitState: confirmApproved ? echoed : undefined,
    roundOutcome:
      confirmResponse.kind === "missing" || confirmApproved
        ? undefined
        : confirmResponse.kind === "elicit" && confirmResponse.action === "cancel"
          ? "cancelled"
          : "declined",
    approvedRound: confirmApproved ? (echoed?.round ?? 0) : undefined,
    answer:
      echoed !== undefined && confirmResponse.kind === "elicit"
        ? {
            action: confirmApproved
              ? "accept"
              : confirmResponse.action === "cancel"
                ? "cancel"
                : "decline",
            tool: echoed.tool,
            argsHash: echoed.argsHash,
            vaultId: echoed.vaultId,
          }
        : undefined,
  };
}

/**
 * THE-1106 fix round 2: a persistent approved-but-mismatched round (see `resolveElicitConfirmation`)
 * gets at most this many TOTAL offers before `offerInputRequired` refuses to mint another and the
 * caller falls through to the plain text error — not the SDK shim's `maxRounds` (8). 2 means: the
 * original offer, plus exactly one retry.
 */
const MAX_MISMATCH_ROUNDS = 2;

/**
 * Mints a `requestState` and returns `inputRequired({ requestState, inputRequests: { confirm } })`
 * for an `elicit_required` error — the SDK then delivers it natively (modern) or via the legacy
 * shim (stdio), per `roundTripDeliverable`. `undefined` when the error carries no `args_hash` (a
 * malformed/unexpected error shape) OR when `previousApprovedRound` is already at
 * `MAX_MISMATCH_ROUNDS` (an approved-but-mismatched round would otherwise re-offer indefinitely) —
 * either way, the caller falls through to the plain text error. Callers gate on
 * `roundTripDeliverable`/`canElicit`/`roundOutcome` themselves (mcp/server.ts's
 * `dispatchToResult`) — this function does not re-check any of that.
 */
export async function offerInputRequired(
  codec: ElicitCodec,
  name: string,
  error: ErrorJSON,
  ctx: { vaultId: string; caller: string | null } & Partial<
    Pick<CallerContext, "db" | "clientInfo" | "hitlRoute">
  >,
  previousApprovedRound: number | undefined,
  /** Confirmation telemetry: when given, a delivered offer is recorded as `offered`. */
  offerSource?: Exclude<HitlSource, "token">,
): Promise<CallToolResult | undefined> {
  if ((previousApprovedRound ?? 0) >= MAX_MISMATCH_ROUNDS) return undefined;
  const details = error as {
    details?: {
      args_hash?: string;
      path?: unknown;
      state_fp?: unknown;
      tool?: unknown;
      vault?: unknown;
    };
  };
  const argsHash = details.details?.args_hash;
  if (typeof argsHash !== "string") return undefined;
  const path = details.details?.path;
  const stateFp = details.details?.state_fp;
  // Sealed with the vault the gate raised the error for (`details.vault`: dispatch's effect vault),
  // not the request context's own: the two differ whenever a call acts on a vault other than the
  // session's. Redemption still compares this to the vault the redeeming call acts on
  // (`stateAuthorizes`), so a state sealed for one vault authorizes no other.
  const vault = details.details?.vault;
  const vaultId = typeof vault === "string" ? vault : ctx.vaultId;
  // The tool the GATE named (`details.tool`), not the one the client called: a tool that delegates
  // (update_active_file -> write_note) is gated under the delegate's identity, and the confirmation
  // is redeemed against exactly that name (`stateAuthorizes`). Sealing the called name made such a
  // gate impossible to satisfy in-band. The form and the offer's mapping to its error keep `name`.
  const gateTool = typeof details.details?.tool === "string" ? details.details.tool : name;
  if (offerSource && ctx.db)
    recordHitlOffer({ ...ctx, vaultId, db: ctx.db }, gateTool, error, offerSource);
  const offer = inputRequired({
    requestState: await codec.mint({
      tool: gateTool,
      argsHash,
      vaultId,
      caller: ctx.caller,
      ...(typeof stateFp === "string" ? { stateFp } : {}),
      round: (previousApprovedRound ?? 0) + 1,
    }),
    inputRequests: {
      confirm: {
        method: "elicitation/create",
        params: buildConfirmElicitationParams(name, typeof path === "string" ? path : undefined),
      },
    },
  }) as unknown as CallToolResult;
  offeredErrors.set(offer, error);
  return offer;
}

/** The `elicit_required` error each offer was minted for, so a failed confirm leg can be turned
 *  back into that refusal (elicit-shim-guard.ts). Keyed by the offer object itself. */
const offeredErrors = new WeakMap<object, ErrorJSON>();

/** The error behind `result` when `result` is an offer minted by `offerInputRequired`. */
export function offeredElicitError(result: unknown): ErrorJSON | undefined {
  return typeof result === "object" && result !== null ? offeredErrors.get(result) : undefined;
}

/** Stamps a non-approving confirm outcome on an `elicit_required` error: `details.reason` for
 *  error-rendering.ts's text, and `message`/`recovery` so the structured channel agrees with it.
 *  `declined` is a hard stop (no retry, no token); `cancelled` means approval was NOT obtained —
 *  nobody refused, so the out-of-band `obsidian-tc elicit` route stays open (the write is still
 *  refused until a token is redeemed). `undefined` (no round happened) stamps the cancel reason. */
export function withRoundOutcome(
  error: ErrorJSON,
  outcome: ConfirmRoundOutcome | undefined,
): ErrorJSON {
  // The same concrete command the text channel renders (vault and caller included), so a model
  // that follows `recovery` mints a token this very call can redeem.
  const command = mintCommandFromDetails(error.details);
  // No round at all (a client that cannot elicit): approval was not obtained either. The message
  // stays (error-rendering.ts keys its text on it); `recovery` swaps the stock `--hash <args_hash>`
  // placeholder for the concrete command, since a mint without `--caller` defaults to `stdio` and
  // redemption refuses a token minted for a different caller.
  if (outcome === undefined) {
    return {
      ...error,
      ...(command
        ? {
            recovery: `A human must approve this call and this client cannot show a confirmation prompt, so nothing was changed. Ask the user; if they approve, mint a single-use token with \`${command}\` and resend with elicit_token. Never reuse an old token.`,
          }
        : {}),
      details: { ...error.details, reason: "approval_not_obtained" },
    } as ErrorJSON;
  }
  const declined = outcome === "declined";
  return {
    ...error,
    message: declined ? error.message : "human approval not obtained",
    recovery: declined
      ? "The user declined this change. Do not retry it and do not mint a token."
      : "Approval was not obtained: no answer to the confirmation prompt came back (it was dismissed, could not be shown, or did not complete), and nothing was changed. Ask the user; if they approve, mint a single-use token with " +
        (command ? `\`${command}\`` : "`obsidian-tc elicit --hash <args_hash> --tool <name>`") +
        " and resend with elicit_token. Never reuse an old token.",
    details: { ...error.details, reason: declined ? "approval_declined" : "approval_not_obtained" },
  } as ErrorJSON;
}

/** An explicit decline is a HARD STOP: the error to return INSTEAD of dispatching, or undefined when
 *  the round was not a decline. Returned before any dispatch because the retry cannot be trusted to
 *  re-raise the gate — a conditional gate (overwrite of an existing note, an active-file target) can
 *  stop applying while the prompt is open, and a dispatch then would run the very change the human
 *  just refused. `answer` carries the confirmation's own tool/args_hash/vault so the text channel
 *  renders the same decline wording; without an echoed state the bare decline still stops the call. */
export function declinedConfirmationError(
  confirmation: Pick<ReturnType<typeof resolveElicitConfirmation>, "roundOutcome" | "answer">,
): ErrorJSON | undefined {
  if (confirmation.roundOutcome !== "declined") return undefined;
  const { answer } = confirmation;
  const base = err.elicitRequired(
    undefined,
    answer ? { tool: answer.tool, args_hash: answer.argsHash, vault: answer.vaultId } : undefined,
  );
  return withRoundOutcome(base.toJSON(), "declined");
}

/** THE-1106 fix round 2 (HIGH, audit): the `CallerContext` patch for a verified, approved
 *  `elicitState` — `elicitState` itself (consumed by `checkHitl`/`requireConfirmation`) plus
 *  `relayElicitConsumed`, which `vault/hitl.ts` calls ONLY when `elicitState` satisfies a
 *  HANDLER-side gate (dispatch's OWN `tc.elicit.consumed` relay never runs for those 16 tools).
 *  `toolName` is an argument, not a closed-over name, because facade/call_capability routing can
 *  make the ACTUAL target differ from `req.params.name`. */
export function elicitStateContextPatch(
  registry: { relayElicitConsumed: (vaultId: string, data: Partial<MorgianaEventData>) => void },
  elicitState: ElicitRequestState,
  vaultId: string,
  caller: string | null,
): {
  elicitState: ElicitRequestState;
  relayElicitConsumed: (toolName: string, effectVaultId?: string) => void;
} {
  return {
    elicitState,
    // The gate reports the vault it acted on; `vaultId` (the session's own) is only the fallback.
    relayElicitConsumed: (toolName: string, effectVaultId?: string) =>
      registry.relayElicitConsumed(effectVaultId ?? vaultId, {
        tool: toolName,
        caller_hash: callerHash(caller),
      }),
  };
}

/** The `CallerContext` for one tools/call request's confirmation state: the verified approved
 *  `elicitState` (see `elicitStateContextPatch`) plus, for telemetry only, the human's answer
 *  (`hitlAnswer`, recorded by `recordHitlAnswer`, read by no gate). */
export function elicitConfirmationContext(
  ctx: CallerContext,
  registry: Parameters<typeof elicitStateContextPatch>[0],
  confirmation: ReturnType<typeof resolveElicitConfirmation>,
  server: Server,
  isModern: boolean,
): CallerContext {
  const source = hitlFormSource(server, isModern);
  const { elicitState, answer } = confirmation;
  const withState =
    elicitState === undefined
      ? ctx
      : { ...ctx, ...elicitStateContextPatch(registry, elicitState, ctx.vaultId, ctx.caller) };
  return answer === undefined ? withState : { ...withState, hitlAnswer: { ...answer, source } };
}
