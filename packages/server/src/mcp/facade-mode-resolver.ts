// THE-1123: `toolFacade.mode: "auto"` resolution — extracted out of mcp/server.ts (which had no
// line budget left under biome's noExcessiveLinesPerFile cap) into its own module, same reasoning
// as tool-projection.ts's own extraction out of the same file.
//
// `opts.facadeMode !== "auto"` (every mode this ticket did not add) is unchanged: a concrete mode,
// decided once, with no clientInfo lookup — same cost and same result as before this ticket.
//
// "auto" needs a per-request clientInfo, which is never available at `createMcpServer` construction
// time — only a request handler sees `extra.mcpReq.envelope`/`req.params._meta`, and legacy stdio's
// `initialize` handshake lands on the `Server` instance itself, not on its construction options. So
// resolution happens lazily, inside whichever handler asks first, and is cached here for the rest of
// that `Server` instance's life: for stdio ONE instance serves the WHOLE connection (McpServerFactory's
// own contract), so this cache is a genuine per-session memo — every `tools/list` and `tools/call`
// after the first NAMED request agrees on the same effective mode. For HTTP, `createMcpHandler`
// constructs a fresh instance per request (transports/http.ts's own doc comment on that), so this
// cache degrades to a same-request memo — the closest thing a stateless transport has to "per session".
//
// CACHING ONLY A NAMED RESOLUTION matters: a request with no observable clientInfo at all must not
// permanently pin the connection to the fallback mode — a LATER request on the same stdio connection
// that DOES carry a name (e.g. the legacy `initialize` lands after an early probe) still gets to
// resolve for real, instead of being stuck behind whatever the first, nameless, request guessed.
import type { Server } from "@modelcontextprotocol/server";
import { clientInfoFromFields, extractClientInfo } from "./client-info";
import { sanitizeDisplayText } from "./elicit-form";
import { explainAutoFacadeMode, resolveAutoFacadeMode } from "./facade-auto";
import type { AutoFacadeExplanation, FacadeMode } from "./facade-mode";

/**
 * De-duplicates a process-wide stderr log across every `createFacadeModeResolver` call in this
 * PROCESS (module scope, not per-resolver-instance) — HTTP constructs a fresh resolver per request,
 * so a per-instance set would still emit one line per request for the same client. Bounded on TWO
 * axes: each key is built by the caller from length-capped parts, and the SET ITSELF is capped at
 * MAX_LOGGED_RESOLUTIONS entries (THE-1123 review fix — the per-entry cap alone does not bound the
 * COUNT of entries: an authenticated HTTP caller sending a fresh forged clientInfo.name on every
 * request grows this Set by one entry per request, unbounded, for the life of the process — a
 * memory-growth DoS). 256 is plenty: the key space that matters in practice is a handful of real
 * clients x a handful of configured/effective-mode combinations: once hit, adding and logging both
 * stop (an already-logged key still dedupes silently, same as always), and ONE final notice line is
 * written so an operator sees the log went quiet rather than assuming nothing more happened.
 */
const MAX_LOGGED_CLIENT_NAME_LEN = 128; // matches client-info.ts's own MAX_LEN
const MAX_LOGGED_RESOLUTIONS = 256;

function createOnceLogger(label: string): (key: string, line: string) => void {
  const seen = new Set<string>();
  let capNoticeWritten = false;
  return (key, line) => {
    if (seen.has(key)) return;
    if (seen.size >= MAX_LOGGED_RESOLUTIONS) {
      if (capNoticeWritten) return;
      capNoticeWritten = true;
      process.stderr.write(
        `obsidian-tc toolFacade: ${label} log capped at ${MAX_LOGGED_RESOLUTIONS} distinct keys\n`,
      );
      return;
    }
    seen.add(key);
    process.stderr.write(line);
  };
}

const logResolutionOnce = createOnceLogger("resolution");
const logExplanationOnce = createOnceLogger("explanation");

function logFacadeResolutionOnce(
  configured: string,
  rawName: string | undefined,
  effective: FacadeMode,
): void {
  // THE-1123 review fix: `rawName` here can be `server.getClientVersion()?.name` BEFORE
  // `clientInfoFromFields`'s bound applies (see resolveFacadeMode below), so this is untrusted,
  // unbounded, and may carry control/line-separator characters a hostile client chose specifically
  // to forge a second log line — `sanitizeDisplayText` (elicit-form.ts, shared with error-rendering
  // and the HITL confirmation text) strips exactly that class and caps the length.
  const name =
    rawName === undefined ? "(none)" : sanitizeDisplayText(rawName, MAX_LOGGED_CLIENT_NAME_LEN);
  logResolutionOnce(
    `${configured}\u0000${name}\u0000${effective}`,
    `obsidian-tc toolFacade: configured=${configured} client=${name} effective=${effective}\n`,
  );
}

/** `toolFacade.explainAutoMode`: the matcher's explanation with the client name bounded and
 *  stripped of control characters (it is untrusted wire data, and this object is both logged and
 *  returned to the caller via server_health). */
function boundedExplanation(e: AutoFacadeExplanation): AutoFacadeExplanation {
  return e.clientName === undefined
    ? e
    : { ...e, clientName: sanitizeDisplayText(e.clientName, MAX_LOGGED_CLIENT_NAME_LEN) };
}

export interface FacadeModeResolver {
  /** The effective, concrete mode for THIS clientName — cached after the first NAMED call when
   *  `configuredMode` is "auto"; a plain pass-through otherwise. */
  resolveFacadeMode(clientName: string | undefined): FacadeMode;
  /** The clientInfo THIS request carried, same precedence `tools/call` already used before this
   *  ticket (THE-861): the lifted envelope first, `_meta` as a fallback for any path that still
   *  legitimately delivers it there — plus, new here, `server.getClientVersion()` (THE-1123): the
   *  SDK's own per-connection cache, seeded from a LEGACY `initialize` handshake's `clientInfo`
   *  param on a connection that never sends a per-request envelope at all (stdio's common case). */
  requestClientName(envelope: unknown, meta: unknown): string | undefined;
  /** `{ facadeExplanation }` for the last auto resolution when `explainAutoMode` is on; `{}`
   *  otherwise — spread onto the caller ctx so the flag-off ctx is byte-identical to before. */
  ctxExplanation(): { facadeExplanation?: AutoFacadeExplanation };
}

/** `opts` is the two `McpServerOptions` fields this needs — taken as an object (rather than two
 *  positional params) so the call site fits on one line under mcp/server.ts's own line budget. */
export function createFacadeModeResolver(
  server: Server,
  opts: {
    facadeMode?: FacadeMode | "auto";
    autoClients?: Readonly<Record<string, FacadeMode>>;
    explainAutoMode?: boolean;
  },
): FacadeModeResolver {
  const { facadeMode: configuredMode, autoClients, explainAutoMode } = opts;
  let autoFacadeResolution: FacadeMode | undefined;
  let lastExplanation: AutoFacadeExplanation | undefined;
  return {
    resolveFacadeMode(clientName) {
      if (configuredMode !== "auto") return configuredMode ?? "flat";
      if (autoFacadeResolution !== undefined) return autoFacadeResolution;
      let mode: FacadeMode;
      if (explainAutoMode) {
        // Same matcher as the else branch (`resolveAutoFacadeMode` is `explainAutoFacadeMode(..).mode`);
        // the flag only adds the record + log line, never a different decision.
        const explanation = boundedExplanation(explainAutoFacadeMode(clientName, autoClients));
        mode = explanation.mode;
        lastExplanation = explanation;
        logExplanationOnce(
          JSON.stringify(explanation),
          `obsidian-tc toolFacade.explain ${JSON.stringify(explanation)}\n`,
        );
      } else mode = resolveAutoFacadeMode(clientName, autoClients);
      // Cache only once a name was actually seen — see the module comment above.
      if (clientName !== undefined) autoFacadeResolution = mode;
      logFacadeResolutionOnce("auto", clientName, mode);
      return mode;
    },
    ctxExplanation() {
      return lastExplanation ? { facadeExplanation: lastExplanation } : {};
    },
    requestClientName(envelope, meta) {
      return (
        extractClientInfo(envelope)?.name ??
        extractClientInfo(meta)?.name ??
        clientInfoFromFields(server.getClientVersion())?.name
      );
    },
  };
}
