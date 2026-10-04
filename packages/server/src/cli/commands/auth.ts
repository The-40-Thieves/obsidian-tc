// `obsidian-tc auth rotate-key|list|revoke`: operator control over the signing-key and issued-token
// registry (auth/registry.ts), which lives in `<cacheDir>/auth.db`, NOT cache.db. Same authorization
// boundary as `token mint` and `elicit`: filesystem access to the cache directory is the credential,
// since whoever can write auth.db and the key files can already mint any token.
//
// Nothing here prints a token or key material. `list` shows jti/kid/sub/exp/state only. Every
// subcommand refuses, naming the recovery, when the registry was initialised but auth.db is lost:
// answering from (or recreating) an empty one would hide that revocations are gone.
import { mkdirSync } from "node:fs";
import { version as VERSION } from "../../../package.json";
import { writeEvent } from "../../audit";
import { openAuthRegistry } from "../../auth/registry-open";
import { asGraceFloorSeconds, generateSigningKey, isAsymmetricAlg } from "../../auth/signing-keys";
import { openConfiguredDatabase } from "../../db/open";
import { provisionCacheDb } from "../../db/provision";
import type { Database } from "../../db/types";
import { CliError } from "../cli-error";
import { type Cmd, resolveOrUsageExit } from "../shared";

const iso = (ms: number | null): string => (ms === null ? "-" : new Date(ms).toISOString());

export async function run_auth(cmd: Cmd<"auth">): Promise<void> {
  const cfg = resolveOrUsageExit(cmd.configPath);
  const { registry, close } = await openAuthRegistry(cfg);
  try {
    const health = registry.health();
    if (health.state === "lost") throw new CliError(health.detail);
    // The registry write is authoritative and already done when this runs; the audit row goes to
    // cache.db's event_log (the audit store) and must not turn a completed revocation into an error.
    const audit = async (event_type: string, caller: string | null) => {
      let cache: Database | undefined;
      try {
        mkdirSync(cfg.cacheDir, { recursive: true });
        cache = await openConfiguredDatabase(cfg, "cache.db");
        provisionCacheDb(cache, { version: VERSION });
        writeEvent(cache, { ts: Date.now(), tool_name: null, caller, status: "ok", event_type });
      } catch (e) {
        process.stderr.write(
          `auth: ${event_type} done, but the audit event was not recorded: ${e instanceof Error ? e.message : String(e)}\n`,
        );
      } finally {
        cache?.close?.();
      }
    };
    const out = (human: string, json: unknown) =>
      process.stdout.write(cmd.json ? `${JSON.stringify(json, null, 2)}\n` : `${human}\n`);

    switch (cmd.sub) {
      case "rotate-key": {
        const purpose = cmd.purpose ?? "mint";
        // The flag wins, including an explicit 0; only an ABSENT flag falls back to the config. An
        // `as` rotation never falls below the floor on its own (access-token lifetime plus skew): an
        // explicit shorter --grace is refused by the registry, not silently raised.
        // The floor and the registry's refusal both use the CONFIGURED lifetime, as boot does.
        const accessTokenSeconds = cfg.auth.as?.accessTokenSeconds;
        const graceSeconds =
          cmd.graceSeconds ??
          (purpose === "as"
            ? Math.max(cfg.auth.rotationGraceSeconds, asGraceFloorSeconds(accessTokenSeconds))
            : cfg.auth.rotationGraceSeconds);
        const alg = cmd.alg ?? (purpose === "as" ? "ES256" : "HS256");
        // Asymmetric key generation is async, so it happens before the (synchronous) registry write.
        const r = registry.rotateKey({
          purpose,
          graceSeconds,
          alg,
          ...(accessTokenSeconds !== undefined ? { accessTokenSeconds } : {}),
          ...(isAsymmetricAlg(alg) ? { generated: await generateSigningKey(alg) } : {}),
        });
        await audit("auth_key_rotated", null);
        const window =
          r.previousKid === null
            ? "no previous key"
            : graceSeconds > 0
              ? `previous key ${r.previousKid} verifies until ${iso(r.previousRetireAfter)}`
              : `previous key ${r.previousKid} retired immediately: its tokens no longer verify`;
        // A `mint` rotation reads exactly as it always has; only an `as` one names its purpose.
        const named = purpose === "as" ? `${alg} \`as\`` : alg;
        out(`new active ${named} signing key ${r.kid}; ${window}`, {
          kid: r.kid,
          alg,
          purpose,
          previous_kid: r.previousKid,
          previous_retire_after: r.previousRetireAfter,
        });
        return;
      }
      case "list": {
        if (cmd.keys) {
          const rows = registry.listKeys().map((k) => ({
            kid: k.kid,
            alg: k.alg,
            purpose: k.purpose,
            state: k.state,
            created: iso(k.createdAt),
            retire_after: iso(k.retireAfter),
          }));
          out(
            [
              "kid\talg\tpurpose\tstate\tcreated\tretire_after",
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
          state:
            t.revokedAt !== null
              ? "revoked"
              : t.expiresAt !== null && t.expiresAt <= now
                ? "expired"
                : "active",
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
        if (res !== "already_revoked") await audit("auth_token_revoked", null);
        const human =
          res === "revoked"
            ? `revoked ${jti}`
            : res === "tombstoned"
              ? `revoked ${jti} (not issued by 'token mint': a tombstone was recorded, so any token carrying this jti is refused)`
              : `${jti} was already revoked`;
        out(human, { jti, status: res });
        return;
      }
    }
  } finally {
    close();
  }
}
