// Builds the `auth.as` doctor view (doctor/auth-as.ts) from config, the already-probed auth registry
// and a read-only look at oauth.db. Kept out of doctor.ts, which sits at the file-length ceiling.
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { configuredJwksOverlap } from "../../auth/as-boot";
import { AS_METADATA_PATH, asIssuingRoutesMounted, enabledAs } from "../../auth/as-metadata";
import { probeOauthDb } from "../../auth/oauth-db";
import type { AuthRegistryProbe } from "../../auth/registry-open";
import type { AuthAsView } from "../../doctor/auth-as";

/** The view for an ENABLED authorization server; undefined when `auth.as` is off (nothing to probe,
 *  nothing to say, and no oauth.db to open). */
export async function probeAuthAsView(
  config: ServerConfig,
  authProbe: Pick<AuthRegistryProbe, "health" | "keys">,
): Promise<AuthAsView | undefined> {
  const as = enabledAs(config.auth);
  if (as === undefined) return undefined;
  const keys = authProbe.keys;
  const jwksOverlap =
    keys !== undefined
      ? await configuredJwksOverlap(config.auth, { listKeys: () => keys }).then(
          (o) => o?.kids ?? [],
          () => [], // an unreadable jwksFile is the JWKS check's finding, not this one's
        )
      : [];
  return {
    enabled: true,
    issuer: as.issuer,
    metadataUrl: `${as.issuer}${AS_METADATA_PATH}`,
    issuing: asIssuingRoutesMounted(),
    signingAlg: as.signingAlg,
    accessTokenSeconds: as.accessTokenSeconds,
    tokenTtlSeconds: config.auth.tokenTtlSeconds,
    ...(config.auth.authorizationServers !== undefined
      ? { authorizationServers: config.auth.authorizationServers }
      : {}),
    registryState: authProbe.health.state,
    oauthDb: await probeOauthDb(config),
    ...(keys !== undefined
      ? {
          keys: keys.map((k) => ({
            kid: k.kid,
            alg: k.alg,
            purpose: k.purpose,
            state: k.state,
            createdAt: k.createdAt,
          })),
        }
      : {}),
    jwksOverlap,
    settings: {
      refreshTokenDays: as.refreshTokenDays,
      dynamicRegistration: as.dynamicRegistration,
      dcr: as.dcr,
      login: as.login,
      clientCount: as.clients.length,
      clientRedirectUris: as.clients.reduce((n, c) => n + c.redirectUris.length, 0),
      cimdAllowedHosts: as.cimd.allowedHosts,
      setupTokenEnv: as.setupTokenEnv,
      // Presence only: the token's value is never read into the report.
      setupTokenSet: (process.env[as.setupTokenEnv] ?? "") !== "",
    },
  };
}
