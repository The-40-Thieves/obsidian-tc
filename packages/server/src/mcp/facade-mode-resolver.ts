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
import { resolveAutoFacadeMode } from "./facade-auto";
import type { FacadeMode } from "./facade-mode";

/**
 * De-duplicates the info-level resolution log across every `createFacadeModeResolver` call in this
 * PROCESS (module scope, not per-resolver-instance) — HTTP constructs a fresh resolver per request,
 * so a per-instance set would still emit one line per request for the same client. Bounded by
 * construction: the key space is `configured` (a handful of literals) x sanitized-and-capped client
 * names x `FacadeMode` (three literals), so a hostile client spamming distinct forged names is the
 * only way to grow this, and each entry is capped at MAX_LOGGED_CLIENT_NAME_LEN bytes.
 */
const loggedFacadeResolutions = new Set<string>();
const MAX_LOGGED_CLIENT_NAME_LEN = 128; // matches client-info.ts's own MAX_LEN

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
  const key = `${configured}\u0000${name}\u0000${effective}`;
  if (loggedFacadeResolutions.has(key)) return;
  loggedFacadeResolutions.add(key);
  process.stderr.write(
    `obsidian-tc toolFacade: configured=${configured} client=${name} effective=${effective}\n`,
  );
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
}

/** `opts` is the two `McpServerOptions` fields this needs — taken as an object (rather than two
 *  positional params) so the call site fits on one line under mcp/server.ts's own line budget. */
export function createFacadeModeResolver(
  server: Server,
  opts: { facadeMode?: FacadeMode | "auto"; autoClients?: Readonly<Record<string, FacadeMode>> },
): FacadeModeResolver {
  const { facadeMode: configuredMode, autoClients } = opts;
  let autoFacadeResolution: FacadeMode | undefined;
  return {
    resolveFacadeMode(clientName) {
      if (configuredMode !== "auto") return configuredMode ?? "flat";
      if (autoFacadeResolution !== undefined) return autoFacadeResolution;
      const mode = resolveAutoFacadeMode(clientName, autoClients);
      // Cache only once a name was actually seen — see the module comment above.
      if (clientName !== undefined) autoFacadeResolution = mode;
      logFacadeResolutionOnce("auto", clientName, mode);
      return mode;
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
