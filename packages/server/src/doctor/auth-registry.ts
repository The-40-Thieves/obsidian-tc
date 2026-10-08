// auth.registry (doctor) — is the signing-key / revocation registry (`<cacheDir>/auth.db`) usable,
// and are its key files trusted? Offline; the view is built by `probeAuthRegistry`.
//
// FAIL, not warn, on a lost registry: every HS256 bearer is being refused, and the only "fix" that
// looks easy (recreate an empty auth.db, or delete a marker) silently makes every revoked token
// and retired key valid again.
import type { Check, CheckResult, CheckStatus } from "./types";

/** The reserved kid of the configured `auth.jwtSecret` (auth/registry.ts CONFIG_KID). Duplicated as
 *  a literal so the doctor stays a leaf module with no import of the registry. */
const CONFIG_KID = "config";
/** A grace window with more than this left is unusually long: a retiring key still verifies every
 *  token it ever signed, so a key kept alive for days after a rotation is barely rotated. */
export const LONG_GRACE_SECONDS = 86_400;

export interface AuthKeyView {
  kid: string;
  alg: string;
  /** `mint` (hand-minted tokens) or `as` (the authorization server's); absent reads as `mint`. */
  purpose?: string;
  state: "active" | "retiring" | "retired";
  /** Epoch ms a retiring key stops verifying. */
  retireAfter: number | null;
}

const human = (seconds: number): string => {
  if (seconds >= 86_400) return `${(seconds / 86_400).toFixed(1)}d`;
  if (seconds >= 3_600) return `${(seconds / 3_600).toFixed(1)}h`;
  if (seconds >= 60) return `${Math.ceil(seconds / 60)}m`;
  return `${seconds}s`;
};

export interface AuthRegistryView {
  authMode: "none" | "jwt" | "oidc";
  state: "uninitialised" | "ok" | "lost";
  /** Why the registry is lost (which table, or an unusable keys directory), when it is. */
  detail?: string;
  dbPath: string;
  keysDir: string;
  /** Why auth.db cannot be opened although it exists (not a SQLite file, a malformed image). */
  unreadable?: string;
  /** Key files (or the directory) failing the trust check. */
  keyFileIssues: string[];
  requireJti: boolean;
  platform: NodeJS.Platform;
  /** The registry's keys (never key material); absent when they could not be read. */
  keys?: AuthKeyView[];
  /** Epoch ms "now"; injectable for tests. */
  now?: number;
  /** `auth.jwtSecret` is set (from the file or OBSIDIAN_TC_JWT_SECRET). */
  jwtSecretConfigured?: boolean;
  /** A JWKS is configured (auth.jwks / jwksFile / jwksUri). */
  jwksConfigured?: boolean;
  /** `auth.as.enabled`: the server generates the `as` signing key at start, ahead of the
   *  no-signing-key refusal, so an otherwise keyless deployment still boots. */
  asEnabled?: boolean;
  /** `auth.rotationGraceSeconds`. */
  rotationGraceSeconds?: number;
}

export function authRegistryCheck(view: AuthRegistryView): Check {
  return {
    id: "auth.registry",
    category: "config",
    run: (): CheckResult => {
      const now = view.now ?? Date.now();
      const keys = view.keys ?? [];
      // Effective state: a window that has elapsed is retired whether or not the reaper has run.
      const retiring = keys
        .filter((k) => k.state === "retiring" && k.retireAfter !== null && k.retireAfter > now)
        .map((k) => ({
          kid: k.kid,
          alg: k.alg,
          retireAfter: k.retireAfter as number,
          remainingSeconds: Math.ceil(((k.retireAfter as number) - now) / 1000),
        }));
      const details = {
        dbPath: view.dbPath,
        keysDir: view.keysDir,
        state: view.state,
        ...(view.detail !== undefined ? { detail: view.detail } : {}),
        ...(view.keys !== undefined
          ? {
              activeKeys: keys.filter((k) => k.state === "active").map((k) => k.kid),
              retiringKeys: retiring.map(
                (k) => `${k.kid} (${k.alg}): ${human(k.remainingSeconds)} left`,
              ),
            }
          : {}),
      };
      // A damaged auth.db makes `serve` abort (it opens the registry in jwt AND oidc mode), whatever
      // static key is configured: say so before the state-based readings below, which would
      // otherwise read the failed open as "not initialised" and report OK.
      if (view.unreadable !== undefined && (view.authMode === "jwt" || view.authMode === "oidc")) {
        return {
          status: "fail",
          summary: `auth registry UNREADABLE: ${view.dbPath} exists but cannot be opened (${view.unreadable}); the server will not start`,
          details: { ...details, unreadable: view.unreadable },
          remediation:
            `restore auth.db from backup (it is NOT regenerable, and \`rm cache.db*\` never touches it). ` +
            `Only if you accept that revoked tokens and retired keys become valid again, move ${view.dbPath} and ${view.keysDir} aside to return to auth.jwtSecret alone (destructive).`,
        };
      }
      // oidc holds no signing keys here (the IdP's keys verify), but the registry still answers
      // "is this jti revoked?", so a LOST one refuses every IdP token exactly as it does in jwt mode
      // and falls through to the fail below; otherwise it is only the revocation list.
      if (view.authMode === "oidc" && view.state !== "lost") {
        return {
          status: "ok",
          summary:
            "auth registry: revocation only (auth.mode oidc; revoke an IdP token with `obsidian-tc auth revoke <jti>`)",
          details,
        };
      }
      if (view.authMode !== "jwt" && view.authMode !== "oidc") {
        return {
          status: "ok",
          summary: "auth registry: not in use (auth.mode is neither jwt nor oidc)",
          details,
        };
      }
      if (view.state === "lost") {
        return {
          status: "fail",
          summary: `auth registry LOST: initialised before (${view.keysDir}) but ${view.dbPath} is missing, or a registry table or the keys directory is empty or unusable; every bearer is refused`,
          details,
          remediation:
            `restore auth.db from backup (it is NOT regenerable, and \`rm cache.db*\` never touches it). ` +
            `Only if you accept that revoked tokens and retired keys become valid again, remove BOTH ${view.dbPath} and ${view.keysDir} to return to auth.jwtSecret alone (destructive).`,
        };
      }
      if (view.keyFileIssues.length > 0) {
        return {
          status: "fail",
          summary: "auth registry: a signing-key file failed the trust check and is refused",
          details,
          issues: view.keyFileIssues,
          remediation: `Fix the mode/owner/symlink problem (keys directory 0700, key files 0600, both owned by the server user), or rotate: \`obsidian-tc auth rotate-key\`.`,
        };
      }
      if (
        view.state === "uninitialised" &&
        view.jwtSecretConfigured === false &&
        view.jwksConfigured === false &&
        view.asEnabled !== true
      ) {
        return {
          status: "fail",
          summary:
            "auth.mode is jwt but there is no signing key: no auth.jwtSecret, no JWKS and an uninitialised registry, so every bearer is refused and the server will not start",
          details,
          remediation:
            "Create a registry signing key with `obsidian-tc auth rotate-key`, or set auth.jwtSecret (or OBSIDIAN_TC_JWT_SECRET).",
        };
      }
      if (view.state === "uninitialised" && view.asEnabled === true) {
        return {
          status: "ok",
          summary:
            "auth registry: not initialised (the authorization server generates its signing key at server start; see auth.as)",
          details,
        };
      }
      if (view.state === "uninitialised") {
        return {
          status: "ok",
          summary:
            "auth registry: not initialised (auth.jwtSecret alone verifies; run `auth rotate-key` or `token mint` to start using it)",
          details,
        };
      }
      const issues: string[] = [];
      let remediation: string | undefined;
      if (!view.requireJti) {
        issues.push(
          "auth.requireJti is off: a token with no jti cannot be revoked individually (only rotating its key kills it)",
        );
        remediation =
          "Set auth.requireJti: true once every live token carries a jti (`token mint` always sets one).";
      }
      if (view.platform === "win32") {
        issues.push(
          "Windows: key-file mode, owner and symlink checks are not enforced (no POSIX permissions); protect the keys directory with its ACL",
        );
      }
      for (const k of retiring) {
        if (k.remainingSeconds > LONG_GRACE_SECONDS) {
          issues.push(
            `retiring signing key ${k.kid} (${k.alg}) has ${human(k.remainingSeconds)} of grace left: it still verifies every token it signed, and a window this long is a key that is barely rotated`,
          );
          remediation ??=
            "The window ends by itself at retire_after (auth list --keys). Use a shorter --grace, or a lower auth.rotationGraceSeconds, for the next rotation.";
        }
      }
      if ((view.rotationGraceSeconds ?? 0) > LONG_GRACE_SECONDS) {
        issues.push(
          `auth.rotationGraceSeconds is ${human(view.rotationGraceSeconds as number)}: every rotation will leave the previous key verifying for that long`,
        );
        remediation ??= "Lower auth.rotationGraceSeconds, or pass a shorter --grace per rotation.";
      }
      const configRetired = keys.some(
        (k) =>
          k.kid === CONFIG_KID &&
          (k.state === "retired" ||
            (k.state === "retiring" && (k.retireAfter === null || k.retireAfter <= now))),
      );
      if (configRetired && view.jwtSecretConfigured === true) {
        issues.push(
          "auth.jwtSecret is still set but the `config` signing key is retired: it no longer verifies or signs anything, and can be removed (the registry keys carry authentication). Removing it makes bulk-read cursors per-process (the HTTP elicit round trip is keyed from the server-local secret and is unaffected)",
        );
        remediation ??= "Remove auth.jwtSecret and OBSIDIAN_TC_JWT_SECRET once you accept that.";
      }
      // `token mint` signs with the active `mint` key: an active `as` key does not make up for it.
      const mintKeys = keys.filter((k) => k.purpose !== "as");
      if (
        view.keys !== undefined &&
        mintKeys.length > 0 &&
        !mintKeys.some((k) => k.state === "active")
      ) {
        issues.push("no active signing key: `token mint` will fail until `auth rotate-key` is run");
        remediation ??= "Run `obsidian-tc auth rotate-key`.";
      }
      const status: CheckStatus = issues.length > 0 ? "warning" : "ok";
      const retiringNote =
        retiring.length > 0
          ? `; ${retiring.length} key${retiring.length === 1 ? "" : "s"} retiring (${retiring
              .map((k) => `${k.kid}: ${human(k.remainingSeconds)} left`)
              .join(", ")})`
          : "";
      return {
        status,
        summary:
          status === "ok"
            ? `auth registry: healthy${retiringNote}`
            : `auth registry: healthy${retiringNote}, with ${issues.length} recommendation${issues.length === 1 ? "" : "s"}`,
        details,
        ...(issues.length > 0 ? { issues } : {}),
        ...(remediation !== undefined ? { remediation } : {}),
      };
    },
  };
}
