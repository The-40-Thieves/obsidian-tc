// Registers the issuing routes this build implements in AS_ROUTES, the one capability source that
// discovery (RFC 8414 metadata, the PRM default, the 401 challenge, `doctor`) is derived from. A route
// is registered here only once it works end to end, so enabling `auth.as` advertises nothing that is
// not served. Authorize and token go together: a client needs both to finish a flow. Refresh tokens
// (a grant of the token endpoint) and revocation (its own route) arrived together in slice S6, client-ID
// metadata documents in S7.
import { mountAuthorizeRoutes } from "./as-authorize";
import { AS_FEATURES, AS_ROUTES } from "./as-metadata";
import { mountRevokeRoute } from "./as-revoke";
import { mountTokenRoute } from "./as-token-endpoint";

export function registerAsIssuingRoutes(): void {
  AS_ROUTES.set("authorize", mountAuthorizeRoutes);
  AS_ROUTES.set("token", mountTokenRoute);
  // Discovery names `revocation_endpoint`, the `refresh_token` grant and `offline_access` only because
  // these exist.
  AS_ROUTES.set("revoke", mountRevokeRoute);
  AS_FEATURES.add("refresh");
  // `client_id_metadata_document_supported` is stated only because as-cimd.ts resolves such clients.
  AS_FEATURES.add("cimd");
}

registerAsIssuingRoutes();
