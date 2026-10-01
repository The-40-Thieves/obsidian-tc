// What a tools/call request says about its own caller, lifted out of the request's `_meta` bag and
// the SDK's lifted-envelope bag. Both are self-reported and untrusted: bounded strings, absent is
// normal. Split out of mcp/server.ts, which sits at biome's line cap.
import { type ClaimedProvenance, extractClaimedProvenance } from "../provenance/types";
import { type ClientInfo, clientInfoFromFields, extractClientInfo } from "./client-info";

export interface RequestCallerMeta {
  clientInfo?: ClientInfo;
  claimedProvenance?: ClaimedProvenance;
}

export function requestCallerMeta(
  meta: unknown,
  envelope: unknown,
  legacyClient: { name?: unknown; version?: unknown } | undefined,
): RequestCallerMeta {
  // Which client software is calling.
  // The SDK LIFTS `io.modelcontextprotocol/clientInfo` out of `params._meta` before any
  // handler runs (`liftWireOnlyMaterial`, shared across both spec eras), surfacing it instead at
  // `extra.mcpReq.envelope` — so `req.params._meta` never carries this key by the time the handler
  // runs; read the lifted location first. `envelope` uses the same reserved keys, so
  // `extractClientInfo` parses either bag identically. The `_meta` read stays as a fallback.
  // 3rd fallback `getClientVersion()` (legacy `initialize`), same bound as above.
  const clientInfo =
    extractClientInfo(envelope) ?? extractClientInfo(meta) ?? clientInfoFromFields(legacyClient);
  // Write provenance: the model/project/agent/machine the client CLAIMS. Not a reserved SDK
  // envelope key, so it stays in `params._meta`; the envelope read is the same belt-and-braces
  // fallback. Self-reported, stored as such, never used to authorize anything.
  const claimedProvenance = extractClaimedProvenance(meta, envelope);
  return {
    ...(clientInfo !== undefined ? { clientInfo } : {}),
    ...(claimedProvenance !== undefined ? { claimedProvenance } : {}),
  };
}
