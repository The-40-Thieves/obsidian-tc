// `obsidian-tc auth as grants list|revoke` (design v2 section 11, slice S6): the operator's view of what
// the bundled authorization server has granted, and the way to take a grant back. Revoking a grant
// kills its refresh tokens and every live access token issued under it. Same authorization boundary
// as `auth revoke`: whoever can write `<cacheDir>` can already do this, so the credential is the
// shell. Nothing here prints a token (none is stored in the clear); a grant id is not a secret.

import { mkdirSync } from "node:fs";
import { listGrants, revokeGrant } from "../../auth/as-grants";
import { enabledAs } from "../../auth/as-metadata";
import { openOauthDb } from "../../auth/oauth-db";
import { openAuthRegistry } from "../../auth/registry-open";
import { CliError } from "../cli-error";
import { type Cmd, resolveOrUsageExit } from "../shared";
import { auditAuthEvent } from "./auth-audit";

const iso = (ms: number | null): string => (ms === null ? "-" : new Date(ms).toISOString());

export async function runAuthAsGrants(cmd: Cmd<"auth">): Promise<void> {
  const cfg = resolveOrUsageExit(cmd.configPath);
  if (enabledAs(cfg.auth) === undefined) {
    throw new CliError(
      "auth.as is not enabled in this config: set auth.as.enabled and auth.as.issuer first (there are no grants to manage)",
    );
  }
  const out = (human: string, json: unknown) =>
    process.stdout.write(cmd.json ? `${JSON.stringify(json, null, 2)}\n` : `${human}\n`);
  // The first command to touch a fresh deployment creates cacheDir (auth.db, oauth.db, secrets): owner-only.
  mkdirSync(cfg.cacheDir, { recursive: true, mode: 0o700 });
  const store = await openOauthDb(cfg);
  try {
    if (cmd.sub === "as-grants-list") {
      const grants = listGrants(store.db, { now: Date.now(), all: cmd.all === true });
      const lines = grants.map((g) =>
        [
          g.id,
          g.username ?? g.sub,
          g.clientId,
          g.scope,
          g.persona ?? "-",
          g.vault ?? "-",
          iso(g.createdAt),
          g.revokedAt === null ? "active" : `revoked ${iso(g.revokedAt)}`,
          String(g.liveFamilies),
        ].join("\t"),
      );
      out(
        [
          "grant\tuser\tclient\tscope\tpersona\tvault\tcreated\tstate\trefresh_families",
          ...lines,
        ].join("\n"),
        grants,
      );
      return;
    }

    // ---- revoke
    const grantId = cmd.grantId as string;
    const { registry, close } = await openAuthRegistry(cfg);
    try {
      const health = registry.health();
      if (health.state === "lost") throw new CliError(health.detail);
      const r = revokeGrant(
        store.db,
        registry,
        grantId,
        cmd.reason ?? "revoked by operator",
        Date.now(),
      );
      if (r.status === "not_found") {
        throw new CliError(`no grant ${grantId} (list them with: obsidian-tc auth as grants list)`);
      }
      if (r.status === "revoked") await auditAuthEvent(cfg, "auth_grant_revoked");
      const swept = `${r.families} refresh ${r.families === 1 ? "family" : "families"} and ${r.accessTokens} access ${r.accessTokens === 1 ? "token" : "tokens"}`;
      const human =
        r.status === "revoked"
          ? `revoked grant ${grantId}: ${swept} revoked`
          : `grant ${grantId} was already revoked; ${swept} were revoked again`;
      out(human, { grant: grantId, ...r });
    } finally {
      close();
    }
  } finally {
    store.close();
  }
}
