// auth.oidc (doctor) — can this server discover its identity provider? `auth.mode: oidc` refuses to
// boot when discovery fails, so a failed probe here is a FAIL, not a warning. The probe is the same
// discovery + JWKS-location validation boot performs (built by the CLI from `discoverOidc`), injected
// so the doctor stays a leaf module and tests need no network.
import { redactEndpoint, redactUrlsInText } from "../telemetry/redact-endpoint";
import type { Check, CheckResult } from "./types";

export type OidcProbeResult =
  | { ok: true; jwksUri: string; keyCount?: number }
  | { ok: false; error: string };

export interface AuthOidcView {
  authMode: "none" | "jwt" | "oidc";
  issuer?: string;
  audience?: string | string[];
  allowedAlgs?: string[];
  clockToleranceSeconds?: number;
  /** `auth.resource` is set, so the issuer is advertised in Protected Resource Metadata. */
  prmConfigured?: boolean;
  requireJti?: boolean;
  probe?: () => Promise<OidcProbeResult>;
}

export function authOidcCheck(view: AuthOidcView): Check {
  return {
    id: "auth.oidc",
    category: "auth",
    run: async (): Promise<CheckResult> => {
      if (view.authMode !== "oidc") {
        return { status: "ok", summary: "auth.oidc: not in use (auth.mode is not oidc)" };
      }
      const details: Record<string, string | string[]> = {
        issuer: view.issuer ?? "",
        audience: view.audience ?? "",
        allowedAlgs: view.allowedAlgs ?? [],
        clockToleranceSeconds: String(view.clockToleranceSeconds ?? ""),
      };
      if (view.probe === undefined) {
        return {
          status: "ok",
          summary: `auth.oidc: issuer ${view.issuer} (discovery not probed)`,
          details,
        };
      }
      let result: OidcProbeResult;
      try {
        result = await view.probe();
      } catch (e) {
        result = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      if (!result.ok) {
        return {
          status: "fail",
          summary: `auth.oidc: identity provider discovery failed, so the server will not start: ${redactUrlsInText(result.error)}`,
          details,
          remediation:
            "Check auth.oidc.issuer (https, exactly the `issuer` in the IdP's discovery document), that this host can reach the IdP, and auth.oidc.jwksUri if set.",
        };
      }
      // Origin only: a key-set URL can carry a credential in its path, query or userinfo.
      const jwksShown = redactEndpoint(result.jwksUri);
      details.jwksUri = jwksShown;
      if (result.keyCount !== undefined) details.keys = String(result.keyCount);
      const issues: string[] = [];
      if (view.prmConfigured !== true) {
        issues.push(
          "auth.resource is not set, so the Protected Resource Metadata document (which advertises the issuer to MCP clients) and the WWW-Authenticate resource_metadata pointer are not served",
        );
      }
      if (view.requireJti !== true) {
        issues.push(
          "auth.requireJti is off: an IdP token with no jti cannot be revoked individually (`obsidian-tc auth revoke <jti>`)",
        );
      }
      return {
        status: issues.length > 0 ? "warning" : "ok",
        summary:
          issues.length > 0
            ? `auth.oidc: ${view.issuer} discovered, with ${issues.length} recommendation${issues.length === 1 ? "" : "s"}`
            : `auth.oidc: ${view.issuer} discovered (jwks_uri ${jwksShown})`,
        details,
        ...(issues.length > 0
          ? {
              issues,
              remediation:
                "Set auth.resource to this server's canonical URL, and auth.requireJti: true if your IdP issues a jti.",
            }
          : {}),
      };
    },
  };
}
