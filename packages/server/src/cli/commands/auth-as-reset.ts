// `obsidian-tc auth as reset-credentials [--user <name>] [--stdin] [--revoke-grants]` (design v2
// section 4.11.5, slice S10): the recovery when the operator has lost the passkey and the password,
// or the hostname changed and every passkey was orphaned with its old rpID. Shell access to the host
// and write access to `<cacheDir>` are the root of trust, as for `set-password`: whoever can write
// oauth.db can already replace the password hash.
//
// It sets a new password, deletes the operator's passkeys and ends every session, in one transaction.
// With --revoke-grants it also revokes every grant of the operator, and with each grant its
// refresh-token families and live access tokens (the same revocation as `auth as grants revoke`).
import { mkdirSync } from "node:fs";
import { listGrants, revokeGrant } from "../../auth/as-grants";
import { enabledAs } from "../../auth/as-metadata";
import { findOperator, normalizeUsername, soleOperator } from "../../auth/as-operator-store";
import { resetOperatorCredentials } from "../../auth/as-passkey-store";
import { argon2Unsupported, hashPassword, passwordProblem } from "../../auth/as-password";
import { openOauthDb } from "../../auth/oauth-db";
import { openAuthRegistry } from "../../auth/registry-open";
import { CliError } from "../cli-error";
import { type Cmd, resolveOrUsageExit } from "../shared";
import { type AuthAsIo, obtainPassword } from "./auth-as";
import { auditAuthEvent } from "./auth-audit";

export async function runAuthAsResetCredentials(
  cmd: Cmd<"auth">,
  io: AuthAsIo = {},
): Promise<void> {
  const cfg = resolveOrUsageExit(cmd.configPath);
  if (enabledAs(cfg.auth) === undefined) {
    throw new CliError(
      "auth.as is not enabled in this config: set auth.as.enabled and auth.as.issuer first (there is no authorization-server account to reset)",
    );
  }
  const unsupported = argon2Unsupported(io.runtime);
  if (unsupported !== undefined) throw new CliError(unsupported);
  const wanted = cmd.user === undefined ? undefined : normalizeUsername(cmd.user);
  if (cmd.user !== undefined && wanted === undefined) {
    throw new CliError("--user may use letters, digits and . _ @ - (up to 64 characters)");
  }

  mkdirSync(cfg.cacheDir, { recursive: true, mode: 0o700 });
  const store = await openOauthDb(cfg);
  try {
    const operator = wanted === undefined ? soleOperator(store.db) : findOperator(store.db, wanted);
    if (operator === undefined) {
      throw new CliError(
        wanted === undefined
          ? "this authorization server has no single operator to reset: claim it with `obsidian-tc auth as set-password`, or name the account with --user"
          : `no operator named ${wanted} (claim the server with \`obsidian-tc auth as set-password\`)`,
      );
    }
    const password = await obtainPassword(cmd.stdin === true, io);
    const problem = passwordProblem(password);
    if (problem !== undefined) throw new CliError(problem);
    const passwordHash = await hashPassword(password);

    // The registry is checked BEFORE anything changes: a reset that stopped half way because the
    // revocation registry is lost would leave the old grants live behind a new password.
    const revoking = cmd.revokeGrants === true ? await openAuthRegistry(cfg) : undefined;
    try {
      if (revoking !== undefined) {
        const health = revoking.registry.health();
        if (health.state === "lost") throw new CliError(health.detail);
      }
      const reset = resetOperatorCredentials(store.db, operator.sub, passwordHash);
      const revoked = { grants: 0, families: 0, accessTokens: 0 };
      if (revoking !== undefined) {
        const now = Date.now();
        for (const g of listGrants(store.db, { now }).filter((g) => g.sub === operator.sub)) {
          const r = revokeGrant(
            store.db,
            revoking.registry,
            g.id,
            "credentials reset by operator",
            now,
          );
          if (r.status === "revoked") revoked.grants++;
          revoked.families += r.families;
          revoked.accessTokens += r.accessTokens;
        }
      }
      await auditAuthEvent(cfg, "auth_credentials_reset");
      const summary = {
        user: operator.username,
        passkeysRemoved: reset.credentials,
        sessionsEnded: reset.sessions,
        ...(revoking !== undefined
          ? {
              grantsRevoked: revoked.grants,
              refreshFamilies: revoked.families,
              accessTokens: revoked.accessTokens,
            }
          : {}),
      };
      process.stdout.write(
        cmd.json
          ? `${JSON.stringify(summary)}\n`
          : `credentials of operator ${operator.username} reset: new password set, ${reset.credentials} passkey${reset.credentials === 1 ? "" : "s"} removed, ${reset.sessions} session${reset.sessions === 1 ? "" : "s"} ended${
              revoking !== undefined
                ? `; ${revoked.grants} grant${revoked.grants === 1 ? "" : "s"} revoked (${revoked.families} refresh families, ${revoked.accessTokens} access tokens)`
                : ""
            }\n`,
      );
    } finally {
      revoking?.close();
    }
  } finally {
    store.close();
  }
}
