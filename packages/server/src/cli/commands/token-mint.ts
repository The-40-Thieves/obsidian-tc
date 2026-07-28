// THE-658 step 2: reproducible, auditable token minting.
//
// Before this, every token this deployment runs on was produced by a Python one-liner in someone's
// shell history — which is how the live tokens ended up with no `aud` claim at all, and how the
// header spacing came to be `json.dumps`'s rather than jose's. A token is a credential; producing
// one should not be an improvisation.
//
// The two refusals below are the point of the command. Both encode a failure this project has
// already paid for:
//
//   * NO AUDIENCE when the config binds one. `jwt.ts` passes `audience` to jose only when
//     configured, and jose then rejects any token lacking `aud` outright. Minting an aud-less token
//     against an audience-bound server produces a credential that is refused on first use with
//     `missing_claim` — and THE-456 makes `auth.audience` MANDATORY for a non-loopback jwt bind, so
//     that is the production shape, not an edge case.
//
//   * TTL OVERSHOOT. `auth.tokenTtlSeconds` caps a token's AGE, not its remaining life: the
//     verifier rejects any token whose `iat` is further back than the cap, however far away `exp`
//     is. A token minted with a year-long `exp` under a 24h cap therefore dies after a day while
//     LOOKING valid for a year, and the failure is a flat 401 with no hint. That exact
//     misunderstanding took the MCP plane down for five days.
import { readFileSync } from "node:fs";
import { SignJWT } from "jose";
import { CliError } from "../args";
import type { Cmd } from "../shared";

/** The parsed `token mint` command — its shape lives in args.ts with every other command. */
export type TokenMintCmd = Cmd<"token-mint">;

/** Only the auth fields this command reads — deliberately not the whole ServerConfig. */
interface AuthShape {
  mode?: string;
  jwtSecret?: string;
  audience?: string;
  resource?: string;
  tokenTtlSeconds?: number;
}

/**
 * Pull the auth block out of a config file without running the full loader.
 *
 * Reading the raw JSON rather than `loadConfig` is intentional: the loader applies defaults and
 * validation aimed at BOOTING a server (it will, for instance, refuse a non-loopback bind under
 * `auth.mode: none`), and none of that should stand between an operator and a token. What matters
 * here is only what the verifier will actually check.
 */
export function readAuthBlock(configPath: string): AuthShape {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    throw new CliError(`cannot read config: ${configPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(`config is not valid JSON: ${configPath}`);
  }
  const auth = (parsed as { auth?: AuthShape } | null)?.auth;
  return auth && typeof auth === "object" ? auth : {};
}

export interface MintPlan {
  claims: Record<string, unknown>;
  ttlSeconds: number;
}

/**
 * Decide what to mint, or refuse. Pure, so every refusal is testable without a filesystem, a clock
 * or a signing key.
 *
 * `now` is injected in seconds since epoch.
 */
export function planMint(auth: AuthShape, cmd: TokenMintCmd, now: number): MintPlan {
  if (!cmd.sub) throw new CliError("token mint requires --sub (the caller identity)");
  if (auth.mode !== "jwt") {
    throw new CliError(
      `config auth.mode is "${auth.mode ?? "none"}", not "jwt" — this server would not verify a minted token`,
    );
  }
  if (!auth.jwtSecret) {
    throw new CliError("config has auth.mode 'jwt' but no auth.jwtSecret to sign with");
  }

  // An explicit --aud wins; otherwise inherit whatever the server will verify against. `resource`
  // is the fallback because createHttpApp defaults the audience to it when PRM is configured
  // (THE-456), so a token minted from a resource-only config still matches.
  const bound = auth.audience ?? auth.resource;
  const aud = cmd.aud ?? bound;
  if (bound && !aud) {
    throw new CliError(
      `config binds tokens to audience "${bound}" — refusing to mint without an aud claim, ` +
        "which this server would reject as missing_claim on first use",
    );
  }

  // Default to the cap when there is one: the longest lifetime the verifier will actually honour.
  const cap = auth.tokenTtlSeconds;
  const ttlSeconds = cmd.ttl ?? cap ?? 31_536_000;
  if (ttlSeconds <= 0) throw new CliError("--ttl must be a positive number of seconds");
  if (cap !== undefined && ttlSeconds > cap) {
    throw new CliError(
      `--ttl ${ttlSeconds}s exceeds auth.tokenTtlSeconds (${cap}s), which caps token AGE, not ` +
        `remaining life — the token would be refused ${cap}s after minting while its exp still ` +
        "looks valid. Lower --ttl, or raise auth.tokenTtlSeconds first.",
    );
  }

  const claims: Record<string, unknown> = {
    sub: cmd.sub,
    // An explicit empty --scopes means "no scopes", which is a legitimate ask (a /metrics scraper
    // needs none). Only an ABSENT flag means "everything".
    scopes:
      cmd.scopes === undefined
        ? ["*"]
        : cmd.scopes
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
    iat: now,
    exp: now + ttlSeconds,
  };
  if (aud) claims.aud = aud;
  // Vault binding is what makes a token single-vault: the dispatcher compares any `vault` argument
  // against this claim (THE-267). Omitted means unbound, which on a multi-vault server is the
  // permissive case — so it is never defaulted.
  if (cmd.vault) claims.vault = cmd.vault;
  return { claims, ttlSeconds };
}

export async function run_token_mint(cmd: TokenMintCmd): Promise<void> {
  const configPath = cmd.configPath ?? process.env.OBSIDIAN_TC_CONFIG;
  if (!configPath) {
    throw new CliError("token mint needs a config path (or OBSIDIAN_TC_CONFIG) to read auth from");
  }
  const auth = readAuthBlock(configPath);
  const { claims, ttlSeconds } = planMint(auth, cmd, Math.floor(Date.now() / 1000));

  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(new TextEncoder().encode(auth.jwtSecret as string));

  if (cmd.json) {
    // The token on its own line in `token`, and the claims beside it so an operator can see what
    // they just created without decoding it. The SECRET is never echoed, here or anywhere.
    process.stdout.write(`${JSON.stringify({ token, claims, ttlSeconds }, null, 2)}\n`);
    return;
  }
  // Bare token on stdout so it composes: `OBSIDIAN_TC_TOKEN=$(obsidian-tc token mint …)`.
  // Everything human-facing goes to stderr, which is why that redirect stays clean.
  process.stderr.write(
    `minted sub=${claims.sub} aud=${claims.aud ?? "(none)"} vault=${claims.vault ?? "(unbound)"} ` +
      `scopes=${JSON.stringify(claims.scopes)} ttl=${ttlSeconds}s\n`,
  );
  process.stdout.write(`${token}\n`);
}
