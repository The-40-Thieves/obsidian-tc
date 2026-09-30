// auth.registry (doctor) — is the signing-key / revocation registry (`<cacheDir>/auth.db`) usable,
// and are its key files trusted? Offline; the view is built by `probeAuthRegistry`.
//
// FAIL, not warn, on a lost registry: every HS256 bearer is being refused, and the only "fix" that
// looks easy (recreate an empty auth.db, or delete the sentinel) silently makes every revoked token
// and retired key valid again.
import type { Check, CheckResult, CheckStatus } from "./types";

export interface AuthRegistryView {
  authMode: "none" | "jwt";
  state: "uninitialised" | "ok" | "lost";
  dbPath: string;
  keysDir: string;
  /** Key files (or the directory) failing the trust check. */
  keyFileIssues: string[];
  requireJti: boolean;
  platform: NodeJS.Platform;
}

export function authRegistryCheck(view: AuthRegistryView): Check {
  return {
    id: "auth.registry",
    category: "config",
    run: (): CheckResult => {
      const details = { dbPath: view.dbPath, keysDir: view.keysDir, state: view.state };
      if (view.authMode !== "jwt") {
        return {
          status: "ok",
          summary: "auth registry: not in use (auth.mode is not jwt)",
          details,
        };
      }
      if (view.state === "lost") {
        return {
          status: "fail",
          summary: `auth registry LOST: initialised before (${view.keysDir}) but ${view.dbPath} is missing or empty; every bearer is refused`,
          details,
          remediation:
            `restore auth.db from backup (it is NOT regenerable, and \`rm cache.db*\` never touches it). ` +
            `Only if you accept that revoked tokens and retired keys become valid again, remove ${view.keysDir} to return to auth.jwtSecret alone.`,
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
      const status: CheckStatus = issues.length > 0 ? "warning" : "ok";
      return {
        status,
        summary:
          status === "ok"
            ? "auth registry: healthy"
            : `auth registry: healthy, with ${issues.length} recommendation${issues.length === 1 ? "" : "s"}`,
        details,
        ...(issues.length > 0 ? { issues } : {}),
        ...(remediation !== undefined ? { remediation } : {}),
      };
    },
  };
}
