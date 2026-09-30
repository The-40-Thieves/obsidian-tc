// `obsidian-tc auth rotate-key|list|revoke`: operator control over the signing-key and issued-token
// registry (auth/registry.ts). Same authorization boundary as `token mint` and `elicit`: opening
// `<cacheDir>/cache.db` is the credential, since whoever can write it can already mint any token.
//
// Nothing here prints a token or key material. `list` shows jti/kid/sub/exp/state only.
import { mkdirSync } from "node:fs";
import { version as VERSION } from "../../../package.json";
import { writeEvent } from "../../audit";
import { authKeysDir, createAuthRegistry } from "../../auth/registry";
import { openConfiguredDatabase } from "../../db/open";
import { provisionCacheDb } from "../../db/provision";
import { CliError } from "../cli-error";
import { type Cmd, resolveOrUsageExit } from "../shared";

const iso = (ms: number | null): string => (ms === null ? "-" : new Date(ms).toISOString());

export async function run_auth(cmd: Cmd<"auth">): Promise<void> {
  const cfg = resolveOrUsageExit(cmd.configPath);
  mkdirSync(cfg.cacheDir, { recursive: true });
  const db = await openConfiguredDatabase(cfg, "cache.db");
  provisionCacheDb(db, { version: VERSION });
  try {
    const registry = createAuthRegistry(db, {
      configSecret: cfg.auth.jwtSecret,
      keysDir: authKeysDir(cfg.cacheDir),
    });
    const audit = (event_type: string, caller: string | null) =>
      writeEvent(db, { ts: Date.now(), tool_name: null, caller, status: "ok", event_type });
    const out = (human: string, json: unknown) =>
      process.stdout.write(cmd.json ? `${JSON.stringify(json, null, 2)}\n` : `${human}\n`);

    switch (cmd.sub) {
      case "rotate-key": {
        const r = registry.rotateKey({ graceSeconds: cmd.graceSeconds ?? 0 });
        audit("auth_key_rotated", null);
        const window =
          r.previousKid === null
            ? "no previous key"
            : (cmd.graceSeconds ?? 0) > 0
              ? `previous key ${r.previousKid} verifies until ${iso(r.previousRetireAfter)}`
              : `previous key ${r.previousKid} retired immediately: its tokens no longer verify`;
        out(`new active signing key ${r.kid}; ${window}`, {
          kid: r.kid,
          previous_kid: r.previousKid,
          previous_retire_after: r.previousRetireAfter,
        });
        return;
      }
      case "list": {
        if (cmd.keys) {
          const rows = registry.listKeys().map((k) => ({
            kid: k.kid,
            state: k.state,
            created: iso(k.createdAt),
            retire_after: iso(k.retireAfter),
          }));
          out(
            [
              "kid\tstate\tcreated\tretire_after",
              ...rows.map((r) => Object.values(r).join("\t")),
            ].join("\n"),
            rows,
          );
          return;
        }
        const now = Date.now();
        const rows = registry.listTokens({ includeExpired: cmd.all }).map((t) => ({
          jti: t.jti,
          kid: t.kid,
          sub: t.sub,
          exp: iso(t.expiresAt),
          state: t.revokedAt !== null ? "revoked" : t.expiresAt <= now ? "expired" : "active",
        }));
        out(
          ["jti\tkid\tsub\texp\tstate", ...rows.map((r) => Object.values(r).join("\t"))].join("\n"),
          rows,
        );
        return;
      }
      case "revoke": {
        const jti = cmd.jti as string;
        const res = registry.revoke(jti, cmd.reason ?? null);
        if (res === "unknown") {
          throw new CliError(
            `no issued token with jti ${jti}. Only tokens minted by 'token mint' are recorded; ` +
              "a token with no jti, or one issued elsewhere, cannot be revoked here.",
          );
        }
        if (res === "revoked") audit("auth_token_revoked", null);
        out(res === "revoked" ? `revoked ${jti}` : `${jti} was already revoked`, {
          jti,
          status: res,
        });
        return;
      }
    }
  } finally {
    db.close?.();
  }
}
