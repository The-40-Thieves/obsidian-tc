// auth.jwks-uri (doctor) — how JWT mode's remote key set (`auth.jwksUri`) is fetched, from the SAME
// decision the fetch makes (auth/jwks-network.ts): pinned to the validated public address (the
// default), loopback, a host listed in `network.plainHttpHosts`, or the deprecated unlisted private
// host. A refused key set means every asymmetric token is rejected, so that is a FAIL; the
// deprecated path is a warning that names the host and the config to add (the same advice
// server_health carries, `jwksUriAdvice`). Resolution is a DNS lookup only: nothing is connected to.
import {
  describeJwksTarget,
  type JwksDescription,
  type JwksNetworkPolicy,
  jwksModeLine,
  unlistedJwksMessage,
} from "../auth/jwks-network";
import {
  type AudienceFields,
  jwksWithoutAudience,
  jwksWithoutAudienceMessage,
} from "../auth/protected-resource";
import type { ResolveHost } from "../gateway/plain-http";
import type { Check, CheckResult } from "./types";

export interface AuthJwksView {
  authMode: "none" | "jwt" | "oidc";
  jwksUri?: string | undefined;
  /** The decision for `jwksUri`, resolved by the CLI (DNS) so this module stays a leaf. */
  describe?: () => Promise<JwksDescription>;
}

/** The two views the CLI hands the doctor for JWT mode's key sources, from the loaded config. */
export function authJwksViews(
  auth: AudienceFields & { jwksUri?: string | undefined },
  plainHttpHosts: readonly string[],
  resolveHost: ResolveHost,
): { authAudience: AuthAudienceView; authJwks: AuthJwksView } {
  return {
    authAudience: { auth },
    authJwks: {
      authMode: auth.mode ?? "none",
      jwksUri: auth.jwksUri,
      describe: () => describeJwksTarget(auth.jwksUri ?? "", { plainHttpHosts, resolveHost }),
    },
  };
}

export function authJwksCheck(view: AuthJwksView): Check {
  return {
    id: "auth.jwks-uri",
    category: "auth",
    run: async (): Promise<CheckResult> => {
      if (view.authMode !== "jwt" || view.jwksUri === undefined || view.describe === undefined) {
        return { status: "ok", summary: "auth.jwksUri: not in use" };
      }
      const d = await view.describe();
      const summary = jwksModeLine(d);
      if (!d.ok) {
        return {
          status: "fail",
          summary,
          issues: [d.reason],
          remediation:
            "Use an https:// key set on a public host, list the exact hostname in network.plainHttpHosts (it must resolve only to loopback, RFC1918, unique-local or, when listed, tailnet 100.64/10 addresses), or set auth.jwksFile for static keys. Public hosts over plain http, link-local and cloud metadata addresses are never allowed.",
        };
      }
      const details = { host: d.host, addresses: d.addresses, mode: d.mode };
      if (d.mode === "private-unlisted") {
        return {
          status: "warning",
          summary,
          details,
          issues: [unlistedJwksMessage(d.host, d.secure, d.addresses.join(", "))],
          remediation: `Add ${JSON.stringify(d.host)} to network.plainHttpHosts.`,
        };
      }
      return { status: "ok", summary, details };
    },
  };
}

export interface AuthAudienceView {
  auth: AudienceFields;
}

/** auth.jwks-audience — a JWKS key source that binds no audience accepts a token its issuer minted
 *  for another service. Works this release (a deprecation, so a warning with the fix), a startup
 *  error in the next minor; `auth.allowMissingAudience: true` is the opt-out. */
export function authAudienceCheck(view: AuthAudienceView): Check {
  return {
    id: "auth.jwks-audience",
    category: "auth",
    run: (): CheckResult => {
      if (!jwksWithoutAudience(view.auth)) {
        return { status: "ok", summary: "auth.audience: bound, opted out, or no JWKS key source" };
      }
      return {
        status: "warning",
        summary:
          "auth: a JWKS key source with no effective audience (deprecated; a startup error in the next minor release)",
        issues: [jwksWithoutAudienceMessage(view.auth)],
        remediation:
          "Set auth.audience to this server's resource identifier (or give auth.resource together with auth.authorizationServers). auth.allowMissingAudience: true opts out if tokens minted for other services really should be accepted.",
      };
    },
  };
}

/** The `server_health` deprecation lines for `auth.jwksUri`: one when the key set works only through
 *  the deprecated unlisted-private path, one when it is refused (every asymmetric token then fails).
 *  Nothing otherwise. Names a host and addresses, so server_health shows it only to a caller that
 *  may see every vault. */
export async function jwksUriAdvice(
  auth: { mode?: string | undefined; jwksUri?: string | undefined } | undefined,
  policy: JwksNetworkPolicy,
): Promise<string[]> {
  if (auth?.mode !== "jwt" || auth.jwksUri === undefined) return [];
  const d = await describeJwksTarget(auth.jwksUri, policy);
  if (!d.ok) return [`auth.jwksUri: ${d.reason}`];
  return d.mode === "private-unlisted"
    ? [unlistedJwksMessage(d.host, d.secure, d.addresses.join(", "))]
    : [];
}
