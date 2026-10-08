// Registers the issuing routes this build implements in AS_ROUTES, the one capability source that
// discovery (RFC 8414 metadata, the PRM default, the 401 challenge, `doctor`) is derived from. A route
// is registered here only once it works end to end, so enabling `auth.as` advertises nothing that is
// not served. Authorize and token go together: a client needs both to finish a flow.
import { mountAuthorizeRoutes } from "./as-authorize";
import { AS_ROUTES } from "./as-metadata";
import { mountTokenRoute } from "./as-token-endpoint";

export function registerAsIssuingRoutes(): void {
  AS_ROUTES.set("authorize", mountAuthorizeRoutes);
  AS_ROUTES.set("token", mountTokenRoute);
}

registerAsIssuingRoutes();
