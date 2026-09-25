// THE-1106 (GH #967 parts 1/3) fix round 1: split out of mcp/server.ts (biome's 700-line
// noExcessiveLinesPerFile), mirroring error-rendering.ts's own split for the same reason.
//
// This module used to also hand-roll a server-initiated `elicitation/create` round trip for
// stdio. That was WRONG: the installed `@modelcontextprotocol/server@2.0.0`'s low-level `Server`
// class (what createMcpServer builds) already does this for any `inputRequired` a handler returns
// on a 2025-era connection, via a DEFAULT-ON `LegacyInputRequiredShim`
// (`Server._wrapHandler("tools/call", ...)` -> `_invokeInputRequiredCapableHandler` ->
// `_legacyInputRequiredShim().fulfill(...)`, `dist/mcp-*.mjs` ~L816/876/897, `legacyShim:
// options?.legacyShim ?? true` at construction ~L493). The shim sends the elicitation/create legs
// itself (gated by the SAME bare-`{}`-means-form rule as below), with a human-paced 600s per-leg
// timeout, `relatedRequestId`, and abort-linking to the outer request, then re-enters the SAME
// handler with the verified `requestState`. Verified by tracing the installed package's source
// (not assumed) and by test/hitl-legacy-shim-elicitation.test.ts.
import {
  type CallToolResult,
  inputRequired,
  inputResponse,
  type Server,
} from "@modelcontextprotocol/server";
import type { ErrorJSON } from "@the-40-thieves/obsidian-tc-shared";
import type { ElicitCodec, ElicitRequestState } from "../elicit-request-state";
// THE-1106 fix round 1 (check:duplicate-exports): reuse tasks.ts's copy rather than declaring a
// second one — this module and tasks.ts independently needed the SAME SEP-2575 fact.
import { MODERN_PROTOCOL_VERSION } from "./tasks";

/**
 * THE-1106 fix round 1 (security review addendum + addendum 2): whether `createMcpServer` asserted
 * the legacy `inputRequired` shim's ACTIVE STATE explicitly, rather than leaving it to the SDK's
 * bundled default. `_inputRequiredServing.legacyShim` (`@modelcontextprotocol/server@2.0.0`,
 * `dist/mcp-*.mjs`'s `resolveLegacyShimOptions`, `legacyShim: options?.legacyShim ?? true` ~L493)
 * is a PRIVATE field with no public accessor, so its live value cannot be read back off a `Server`
 * instance — `createMcpServer` always passes `inputRequired: { legacyShim: opts.legacyElicitationShim
 * === true }`, an explicit `true` OR `false` depending on `McpServerOptions.legacyElicitationShim`,
 * never the SDK's own default in either direction. `true` here means only that this ASSERTION
 * happened, NOT that the shim is active for THIS instance — that still depends on the per-instance
 * `legacyElicitationShim` flag, checked separately by `roundTripDeliverable` below.
 */
export const LEGACY_SHIM_ASSERTED_EXPLICIT = true;

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

/**
 * Whether an `inputRequired` handler return will ACTUALLY be delivered for this request — the
 * fail-closed gate `dispatchToResult` uses before offering the HITL round trip at all. TRUE for
 * either delivery path: native modern handling (`negotiatedModern`), or the legacy shim —
 * STDIO-ONLY, opted into per-instance (`legacyElicitationShim === true`; `false`/absent on every
 * HTTP-served server, so a legacy-era HTTP session takes neither path) and asserted explicit at
 * construction (`LEGACY_SHIM_ASSERTED_EXPLICIT`). Not a SECURITY gate either way — `checkHitl`
 * only ever accepts a verified `requestState` (itself now also checked against the confirm leg's
 * OWN accept/decline answer — see mcp/server.ts's `confirmApproved`) or a single-use token — a
 * wrong answer here degrades to the plain `elicit_required` text error rather than to a broken
 * shape. Server-initiated legs over Streamable HTTP are unverified against real clients and
 * explicitly out of scope, which is why the legacy half is opt-in and stdio-only.
 */
export function roundTripDeliverable(
  server: Server,
  isModern: boolean,
  legacyElicitationShim: boolean | undefined,
): boolean {
  return (
    negotiatedModern(server, isModern) ||
    (legacyElicitationShim === true && LEGACY_SHIM_ASSERTED_EXPLICIT)
  );
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
 * THE-1106 fix round 1 (MEDIUM/LOW 2, cross-vendor review — 2nd pass): `path` (and, defensively,
 * `tool`) arrive here as UNTRUSTED display text — a vault-relative `VaultPath` only rejects `..`
 * and an absolute leading slash, so it may legally contain newlines, backticks, double quotes, or
 * arbitrary prose. Left unsanitized, a crafted path can inject a fake extra "line" into a rendered
 * form message or directive sentence — e.g. a path ending the sentence and appending its own
 * spoofed `confirm with: obsidian-tc elicit ...` line, or a bogus "this is a harmless preview"
 * reassurance — that a human skimming the text, or a naive line-based locator, could mistake for
 * the real one. Strips C0/DEL control characters AND the backtick (the first review's fix rendered
 * the value inside backticks in prose — `` on `${path}` `` — so a path containing its own backtick
 * could close that span early; stripping it here closes that hole even though callers now quote
 * with `JSON.stringify` instead, which cannot be broken out of by ANY character) and caps length
 * so a pathologically long value cannot crowd out the real instruction.
 */
export function sanitizeDisplayText(value: string, maxLen = 200): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately stripping control chars
  const stripped = value.replace(/[\x00-\x1f\x7f`]/g, "");
  return stripped.length > maxLen ? `${stripped.slice(0, maxLen)}…` : stripped;
}

/**
 * The confirmation form the `inputRequired` round trip sends, on EITHER era (native modern
 * handling, or the legacy shim above) — ONE builder so the message text and `approve: boolean`
 * schema cannot drift between them. `path`, when given, names the call's target (e.g. the note
 * being overwritten/deleted/moved) so the human approving it can see WHAT before approving;
 * omitted when the triggering error carried none (e.g. the always-on `destructive: true` dispatch
 * gate, which has no `proposed` object to source a path from — see policy-gates.ts). Rendered as a
 * `JSON.stringify`d literal (after `sanitizeDisplayText`, belt-and-suspenders): the quoting itself
 * cannot be forged by any character the value contains, unlike interpolating it into a hand-picked
 * delimiter (backticks, parens) that the value could itself contain.
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
  const safeName = sanitizeDisplayText(name);
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
 * `roundDeclinedOrCancelled` is true when a round happened for THIS wire request AND it was NOT an
 * approval — used by `dispatchToResult` to stop offering a SECOND `inputRequired` for the SAME
 * declined confirmation, which would otherwise loop (the re-thrown `elicit_required` looks
 * identical to a first attempt). Deliberately NOT triggered by an approved-but-mismatched state
 * (e.g. one minted for different arguments, a different vault, or an expired/forged one, still
 * approved by the human) — that case behaves like a fresh, never-yet-offered call, correctly
 * getting its OWN round trip rather than a suppressed error.
 */
export function resolveElicitConfirmation(mcpReq: {
  requestState?: <T>() => T | undefined;
  inputResponses?: Record<string, unknown>;
}): { elicitState: ElicitRequestState | undefined; roundDeclinedOrCancelled: boolean } {
  const echoed = mcpReq.requestState?.<ElicitRequestState>();
  const confirmResponse = inputResponse(mcpReq.inputResponses, "confirm");
  const confirmApproved =
    confirmResponse.kind === "elicit" &&
    confirmResponse.action === "accept" &&
    confirmResponse.content?.approve === true;
  return {
    elicitState: confirmApproved ? echoed : undefined,
    roundDeclinedOrCancelled: confirmResponse.kind !== "missing" && !confirmApproved,
  };
}

/**
 * Mints a `requestState` and returns `inputRequired({ requestState, inputRequests: { confirm } })`
 * for an `elicit_required` error — the SDK then delivers it natively (modern) or via the legacy
 * shim (stdio), per `roundTripDeliverable`. `undefined` when the error carries no `args_hash` (a
 * malformed/unexpected error shape), in which case the caller falls through to the plain text
 * error. Callers gate on `roundTripDeliverable`/`canElicit`/`roundDeclinedOrCancelled` themselves
 * (mcp/server.ts's `dispatchToResult`) — this function does not re-check any of that.
 */
export async function offerInputRequired(
  codec: ElicitCodec,
  name: string,
  error: ErrorJSON,
  ctx: { vaultId: string; caller: string | null },
): Promise<CallToolResult | undefined> {
  const details = error as { details?: { args_hash?: string; path?: unknown } };
  const argsHash = details.details?.args_hash;
  if (typeof argsHash !== "string") return undefined;
  const path = details.details?.path;
  return inputRequired({
    requestState: await codec.mint({
      tool: name,
      argsHash,
      vaultId: ctx.vaultId,
      caller: ctx.caller,
    }),
    inputRequests: {
      confirm: {
        method: "elicitation/create",
        params: buildConfirmElicitationParams(name, typeof path === "string" ? path : undefined),
      },
    },
  }) as unknown as CallToolResult;
}
