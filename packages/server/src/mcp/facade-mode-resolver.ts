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
// after the first agrees on the same effective mode. For HTTP, `createMcpHandler` constructs a fresh
// instance per request (transports/http.ts's own doc comment on that), so this cache degrades to a
// same-request memo — the closest thing a stateless transport has to "per session".
import type { Server } from "@modelcontextprotocol/server";
import { extractClientInfo } from "./client-info";
import type { FacadeMode } from "./facade";
import { resolveAutoFacadeMode } from "./facade-auto";

export interface FacadeModeResolver {
  /** The effective, concrete mode for THIS clientName — cached after the first call when
   *  `configuredMode` is "auto"; a plain pass-through otherwise. */
  resolveFacadeMode(clientName: string | undefined): FacadeMode;
  /** The clientInfo THIS request carried, same precedence `tools/call` already used before this
   *  ticket (THE-861): the lifted envelope first, `_meta` as a fallback for any path that still
   *  legitimately delivers it there — plus, new here, `server.getClientVersion()` (THE-1123): the
   *  SDK's own per-connection cache, seeded from a LEGACY `initialize` handshake's `clientInfo`
   *  param on a connection that never sends a per-request envelope at all (stdio's common case). */
  requestClientName(envelope: unknown, meta: unknown): string | undefined;
}

export function createFacadeModeResolver(
  server: Server,
  configuredMode: FacadeMode | "auto" | undefined,
  autoClients: Readonly<Record<string, FacadeMode>> | undefined,
): FacadeModeResolver {
  let autoFacadeResolution: FacadeMode | undefined;
  return {
    resolveFacadeMode(clientName) {
      if (configuredMode !== "auto") return configuredMode ?? "flat";
      if (autoFacadeResolution !== undefined) return autoFacadeResolution;
      const mode = resolveAutoFacadeMode(clientName, autoClients);
      autoFacadeResolution = mode;
      process.stderr.write(
        `obsidian-tc toolFacade: configured=auto client=${clientName ?? "(none)"} effective=${mode}\n`,
      );
      return mode;
    },
    requestClientName(envelope, meta) {
      return (
        extractClientInfo(envelope)?.name ??
        extractClientInfo(meta)?.name ??
        server.getClientVersion()?.name
      );
    },
  };
}
