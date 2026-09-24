// THE-1106 (GH #967 parts 1/3): server-initiated `elicitation/create` on a LEGACY-era connection
// (2025-11-25 / 2025-06-18 — stdio never negotiates 2026-07-28; see McpServerOptions
// .inBandElicitation's doc comment in mcp/server.ts for why the modern `inputRequired` round trip
// is unreachable there). Split out of mcp/server.ts (biome's 700-line noExcessiveLinesPerFile),
// mirroring error-rendering.ts's own split for the same reason.
import type { CallToolResult, Server } from "@modelcontextprotocol/server";
import type { ErrorJSON, ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { issueElicitToken } from "../elicit";
import { callerHash } from "../throttle";
import { emitLog, type RequestLog } from "./client-features";
import { splitElicitToken } from "./elicit-token";
import type { CallerContext, ToolRegistry } from "./registry";

/**
 * Did the caller advertise form elicitation?
 *
 * The 2026-07-28 revision carries client capabilities in the per-request `_meta` envelope, but the
 * SDK parses and consumes those keys before a handler runs — so this reads the capabilities object
 * the SDK exposes rather than re-parsing the wire. Offering an `inputRequired` naming a capability
 * the client never advertised is a hard -32021 protocol error, so this gate decides whether the
 * round trip is offered at all. mcp/server.ts's modern branch reuses this SAME predicate, so both
 * eras agree on what "the client supports form elicitation" means.
 *
 * THE-1106 fix: a BARE `elicitation: {}` declaration (no `form`, no `url` sub-key at all) is the
 * 2025-11-25-era client's way of declaring form support — the spec's pre-mode meaning of an empty
 * elicitation capability object, kept for backwards compatibility. The prior `"form" in elicitation`
 * check required the `form` key to be spelled out, so a spec-conformant 2025 client sending the
 * bare, legal `elicitation: {}` (Claude Code 2.1.281 over stdio is one measured example) was
 * classified as NOT supporting form elicitation. Only an explicit `elicitation: { url: {} }` with no
 * `form` key opts OUT of the implied default. This mirrors `getSupportedElicitationModes`, exported
 * publicly from `@modelcontextprotocol/sdk`'s client module (`dist/esm/client/index.js`) — that
 * function is written for a CLIENT to interpret ITS OWN declared capabilities and is not meant to be
 * imported into server code (and pulling the client module into the server bundle would cross a
 * boundary `check:boundaries` polices), so the rule is copied here rather than imported;
 * `@modelcontextprotocol/server`'s own internal `isImpliedCapabilityMember` (core-internal, not part
 * of its public export surface) encodes the identical rule for the SAME reason, confirming this is
 * the spec's intent, not one client's private convention.
 */
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
 * The confirmation form both HITL round trips send: the modern (SEP-2260/2322) `inputRequired`
 * embed and THE-1106's legacy server-initiated `elicitation/create`. ONE builder so the message
 * text and `approve: boolean` schema cannot drift between the two eras — they are the same
 * confirmation, only the transport mechanics differ. `path`, when given, names the call's target
 * (e.g. the note being overwritten/deleted/moved) so the human approving it can see WHAT before
 * approving; omitted when the triggering error carried none (e.g. the always-on `destructive: true`
 * dispatch gate, which has no `proposed` object to source a path from — see policy-gates.ts).
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
  const target = path !== undefined ? ` (target: ${path})` : "";
  return {
    mode: "form",
    message: `Confirm ${name}: this call changes vault content and needs approval${target}.`,
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
 * Maps a raw dispatch outcome to a `CallToolResult` — shared by mcp/server.ts's `dispatchToResult`
 * (a first attempt) and the in-band re-dispatch below (a second one), so both get IDENTICAL
 * success/overflow/error formatting without re-running the `elicit_required` interception a second
 * time (which would offer a second confirmation, not complete the call). `formatData`/`errorToResult`
 * are passed in rather than imported: they close over server.ts-local state (the byte-governor
 * serialization cache, `formatErrorDetail`) that has no reason to live in this module.
 */
export function toCallToolResult(
  formatData: (data: unknown) => CallToolResult,
  errorToResult: (error: ErrorJSON) => CallToolResult,
  result: ToolResult,
  name: string,
  log?: RequestLog,
): CallToolResult {
  if (!result.ok) return errorToResult(result.error);
  const overflow = result.meta.overflow_bytes;
  if (typeof overflow === "number" && overflow > 0) {
    void emitLog(log, {
      level: "warning",
      logger: "obsidian-tc/governor",
      data: { tool: name, overflow_bytes: overflow, message: "response truncated by byte ceiling" },
    });
  }
  return formatData(result.data);
}

export interface InBandElicitationDeps {
  server: Server;
  registry: ToolRegistry;
  formatData: (data: unknown) => CallToolResult;
  errorToResult: (error: ErrorJSON) => CallToolResult;
}

/**
 * Server-initiated `elicitation/create` for one gated call. Returns `undefined` on anything other
 * than a clean `{action: "accept", content: {approve: true}}` — decline, cancel, `approve: false`,
 * a malformed/unexpected response, or a transport error all fall through to that same `undefined`,
 * so the caller (mcp/server.ts's dispatchToResult) renders the ordinary `elicit_required` error
 * exactly once and never loops or re-prompts. Every outcome is logged via `tc.elicit.in_band`
 * (approve or not) so an operator can see a confirmation that never touched the CLI mint path.
 */
export async function tryInBandElicitation(
  deps: InBandElicitationDeps,
  name: string,
  args: Record<string, unknown>,
  ctx: CallerContext,
  argsHash: string,
  path: string | undefined,
  log: RequestLog | undefined,
): Promise<CallToolResult | undefined> {
  let elicited: { action: string; content?: Record<string, unknown> } | undefined;
  let transportFailed = false;
  try {
    // THE-1106: the raw JSON-RPC `request()` call, NOT the SDK's `elicitInput()` convenience
    // wrapper. `elicitInput()` re-checks `clientCapabilities.elicitation.form` literally (it does
    // not implement the implied-form rule `clientSupportsFormElicitation` above already applied, by
    // design — see @modelcontextprotocol/server's `_sendElicitationLeg` doc comment, "the shim uses
    // it because its gate differs from the public checks"), so it would reject exactly the bare
    // `elicitation: {}` client this fix exists to support. `request()` is public, documented, and is
    // what `_sendElicitationLeg` itself calls internally for form mode — verified against the
    // installed `@modelcontextprotocol/server@2.0.0`'s `dist/createMcpHandler-*.d.mts`
    // (Protocol.request, ~L2415) and `dist/mcp-*.mjs` (`_sendElicitationLeg`'s form case). We
    // already did our OWN (correct) capability check via `canElicit` before calling this function,
    // so skipping the SDK's redundant, stricter one is deliberate, not a bypass of anything this
    // fix did not already re-derive.
    elicited = (await deps.server.request({
      method: "elicitation/create",
      params: buildConfirmElicitationParams(name, path),
    })) as { action: string; content?: Record<string, unknown> };
  } catch {
    transportFailed = true; // fall through to the plain elicit_required error, below
  }
  const approved = elicited?.action === "accept" && elicited?.content?.approve === true;
  // THE-1106 item 6: one `tc.elicit.in_band` event per attempt, whatever the outcome, so an
  // operator can see a confirmation that never touched the CLI mint path — including a declined
  // one, which is exactly the case the CLI's own `tc.elicit.requested`/`tc.elicit.consumed` pair
  // would otherwise leave invisible (dispatch never sees an in-band decline; it only sees the
  // `elicit_required` error this function's caller renders instead). `MorgianaEventData` has no
  // generic "action" field — the outcome rides in `status` (ok/denied/error) plus `error.code`
  // naming the specific action (accept/decline/cancel/transport_error), the same shape
  // `error: {code, message}` every other error-carrying event already uses.
  deps.registry.relayInBandElicit(ctx.vaultId, {
    tool: name,
    caller_hash: callerHash(ctx.caller),
    status: approved ? "ok" : transportFailed ? "error" : "denied",
    ...(approved
      ? {}
      : {
          error: {
            code: transportFailed ? "transport_error" : (elicited?.action ?? "unknown"),
            message: transportFailed
              ? "elicitation/create request failed"
              : `client responded ${elicited?.action}${elicited?.action === "accept" ? " with approve:false" : ""}`,
          },
        }),
  });
  if (!approved) return undefined;
  // Mint a REAL, single-use elicit token bound to this exact tool/vault/caller/args_hash — the same
  // mechanism `obsidian-tc elicit` mints and dispatch's HITL gate verifies. The security property
  // ("a human approved THIS call") is identical to the CLI path; only how the human was asked
  // differs.
  const token = issueElicitToken(ctx.db, {
    vaultId: ctx.vaultId,
    toolName: name,
    argsHash,
    caller: ctx.caller,
  });
  // Re-dispatch the SAME call exactly once, through the SAME `elicit_token` -> `ctx.elicitToken`
  // path a real client's resubmission takes (splitElicitToken, THE-1037/#925) — never a hand-rolled
  // second verification. `args` here already has no `elicit_token` key (it was split off before
  // dispatchToResult ran the first attempt), so re-adding it and re-splitting produces byte-identical
  // args to what a client-resubmitted call would carry.
  const { args: redispatchArgs, ctx: redispatchCtx } = splitElicitToken(
    { ...args, elicit_token: token },
    ctx,
  );
  const result = await deps.registry.dispatch(name, redispatchArgs, redispatchCtx);
  return toCallToolResult(deps.formatData, deps.errorToResult, result, name, log);
}
