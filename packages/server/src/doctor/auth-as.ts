// auth.as (doctor) — is the bundled authorization server (`auth.as`) in a state that can serve? The
// metadata URL and issuer, whether oauth.db is claimed, the active `as` signing key (kid, algorithm,
// age), DCR state, the settings the later routes will read, and the backup reminder. Offline; the
// view is built by run_doctor from config, `probeAuthRegistry` and `probeOauthDb`, and never carries
// key material or a secret's value.
import type { Check, CheckResult, CheckStatus } from "./types";

/** An `as` key older than this is a rotation candidate: it signs every access token it ever issued. */
export const AS_KEY_WARN_DAYS = 180;
const DAY_MS = 86_400_000;

export interface AsKeyView {
  kid: string;
  alg: string;
  /** `mint` or `as`; only `as` keys matter here. */
  purpose?: string;
  state: "active" | "retiring" | "retired";
  /** Epoch ms the key was created. */
  createdAt: number;
}

export interface AuthAsSettingsView {
  refreshTokenDays: number;
  dynamicRegistration: boolean;
  dcr: { maxClients: number; perIpPerHour: number; unusedDays: number };
  login: { maxFailuresPerWindow: number; windowSeconds: number };
  clientCount: number;
  /** Redirect URIs across the pre-registered clients. */
  clientRedirectUris: number;
  cimdAllowedHosts: string[];
  /** The NAME of the environment variable that carries the setup token. */
  setupTokenEnv: string;
  /** Whether that variable is set in this process's environment (its value is never read here). */
  setupTokenSet: boolean;
}

export interface AuthAsView {
  enabled: boolean;
  issuer?: string;
  metadataUrl?: string;
  /** Whether the authorize and token routes are mounted (`asIssuingRoutesMounted`). While false the
   *  server publishes no authorization-server metadata, PRM default or challenge pointer. */
  issuing: boolean;
  signingAlg: string;
  accessTokenSeconds: number;
  tokenTtlSeconds: number;
  /** `auth.authorizationServers` as configured (absent = defaults to the issuer). */
  authorizationServers?: string[];
  registryState: "uninitialised" | "ok" | "lost";
  oauthDb: { path: string; exists: boolean; claimed: boolean; unreadable?: string };
  /** The registry's keys (never key material); absent when they could not be read. */
  keys?: AsKeyView[];
  /** Kids of `as` keys also present in the configured `auth.jwks` / `auth.jwksFile`. */
  jwksOverlap: string[];
  settings: AuthAsSettingsView;
  /** Epoch ms "now"; injectable for tests. */
  now?: number;
}

const BACKUP = "back up oauth.db (with -wal), auth.db and auth-keys/ together";

export function authAsCheck(view: AuthAsView): Check {
  return {
    id: "auth.as",
    category: "config",
    run: (): CheckResult => {
      if (!view.enabled) {
        return {
          status: "ok",
          summary: "authorization server: not enabled (auth.as.enabled is false)",
        };
      }
      const now = view.now ?? Date.now();
      const s = view.settings;
      const active = (view.keys ?? []).find((k) => k.purpose === "as" && k.state === "active");
      const failures: string[] = [];
      const warnings: string[] = [];
      if (view.registryState === "lost") {
        failures.push(
          "the auth registry is LOST: the server cannot sign or verify authorization-server tokens (see auth.registry)",
        );
      } else if (active === undefined) {
        failures.push(
          "no active `as` signing key: it is generated at server start, so start the server once, or run `obsidian-tc auth rotate-key --purpose as`",
        );
      }
      if (view.oauthDb.unreadable !== undefined) {
        failures.push(
          `oauth.db is unreadable (${view.oauthDb.unreadable}): restore it from backup, or move it aside to start fresh (clients sign in again)`,
        );
      }
      if (view.jwksOverlap.length > 0) {
        failures.push(
          `auth.jwks or auth.jwksFile contains the authorization server's own key ${view.jwksOverlap.join(", ")}: remove it (a remote auth.jwksUri cannot be checked here)`,
        );
      }
      if (view.oauthDb.unreadable === undefined && !view.oauthDb.claimed) {
        warnings.push(
          "unclaimed: no operator account exists yet, so every authorize and token request is refused until it is claimed",
        );
      }
      if (active !== undefined) {
        const ageDays = Math.floor((now - active.createdAt) / DAY_MS);
        if (ageDays > AS_KEY_WARN_DAYS) {
          warnings.push(
            `the active \`as\` key ${active.kid} is ${ageDays} days old (over ${AS_KEY_WARN_DAYS}): rotate it with \`obsidian-tc auth rotate-key --purpose as\``,
          );
        }
        if (active.alg !== view.signingAlg) {
          warnings.push(
            `the active \`as\` key is ${active.alg} but auth.as.signingAlg is ${view.signingAlg}: rotate to switch`,
          );
        }
      }
      if (
        view.issuer !== undefined &&
        view.authorizationServers?.[0] !== undefined &&
        view.authorizationServers[0] !== view.issuer
      ) {
        warnings.push(
          `auth.authorizationServers lists ${view.authorizationServers[0]} first, not the issuer ${view.issuer}`,
        );
      }
      if (view.tokenTtlSeconds < view.accessTokenSeconds) {
        warnings.push(
          `auth.tokenTtlSeconds (${view.tokenTtlSeconds}) is below auth.as.accessTokenSeconds (${view.accessTokenSeconds}): the age cap would reject tokens before they expire`,
        );
      }
      const status: CheckStatus =
        failures.length > 0 ? "fail" : warnings.length > 0 ? "warning" : "ok";
      const issues = [...failures, ...warnings];
      const issuingNote = view.issuing ? "" : "; AS enabled, issuing routes not yet available";
      return {
        status,
        summary:
          status === "ok"
            ? `authorization server enabled: ${view.issuer} (claimed, signing key ${active?.kid})${issuingNote}`
            : `authorization server: ${issues.length} problem${issues.length === 1 ? "" : "s"} (${(failures[0] ?? warnings[0] ?? "").split(":")[0]})${issuingNote}`,
        details: {
          issuer: view.issuer ?? "",
          metadataUrl: view.issuing
            ? (view.metadataUrl ?? "")
            : `${view.metadataUrl ?? ""} (not served yet: issuing routes not yet available)`,
          issuing: view.issuing ? "available" : "not yet available",
          state: view.oauthDb.claimed ? "claimed" : "unclaimed",
          signingKey:
            active === undefined
              ? "none"
              : `${active.kid} (${active.alg}, ${Math.floor((now - active.createdAt) / DAY_MS)}d old)`,
          dynamicRegistration: s.dynamicRegistration ? "on" : "off",
          oauthDb: `${view.oauthDb.path} (${view.oauthDb.exists ? "present" : "absent: created at server start"})`,
          settings: [
            `refreshTokenDays=${s.refreshTokenDays}`,
            `dcr.maxClients=${s.dcr.maxClients} dcr.perIpPerHour=${s.dcr.perIpPerHour} dcr.unusedDays=${s.dcr.unusedDays}`,
            `login.maxFailuresPerWindow=${s.login.maxFailuresPerWindow} login.windowSeconds=${s.login.windowSeconds}`,
            `clients=${s.clientCount} (${s.clientRedirectUris} redirect URIs)`,
            `cimd.allowedHosts=${s.cimdAllowedHosts.length === 0 ? "(any public https host)" : s.cimdAllowedHosts.join(", ")}`,
            `setupTokenEnv=${s.setupTokenEnv} (${s.setupTokenSet ? "set" : "not set"})`,
          ],
          backup: BACKUP,
        },
        ...(issues.length > 0 ? { issues } : {}),
      };
    },
  };
}
