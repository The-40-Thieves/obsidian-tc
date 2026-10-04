// Boot-time pieces of the bundled authorization server that need the auth registry (design v2
// sections 4.1, 4.2): generating the `as` signing key, and refusing a configured JWKS that smuggles
// that key back in as a hand-minted-token key.
import { readFileSync } from "node:fs";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { calculateJwkThumbprint, type JWK } from "jose";
import type { AuthKey, AuthRegistry } from "./registry";
import { type AsymmetricAlg, generateSigningKey } from "./signing-keys";

export interface EnsureAsKeyResult {
  /** True only when THIS call generated and activated a new key. */
  created: boolean;
  /** The active `as` key's kid, when there is one. */
  kid?: string;
  /** Why nothing was generated, when nothing was and no active key exists or it is not usable. */
  skipped?: "lost" | "alg_mismatch";
  /** The active key's algorithm when it differs from the configured one (`doctor` warns). */
  existingAlg?: string;
}

const activeAsKey = (registry: AuthRegistry): AuthKey | undefined =>
  registry.listKeys().find((k) => k.purpose === "as" && k.state === "active");

/**
 * Make sure the registry holds an ACTIVE `as` key, generating one on first boot with the AS enabled.
 * Idempotent: an existing active key is never touched, in particular never replaced because the
 * configured algorithm changed (that is a rotation, an operator decision made with
 * `auth rotate-key --purpose as`, and `doctor` warns about the mismatch). Never writes into a LOST
 * registry: generating a key there would paper over the loss that `registry.health()` reports.
 * Two processes starting together may both see no key; the one-active-key-per-purpose unique index
 * lets only one insert win, and the loser re-reads instead of failing the boot.
 */
export async function ensureAsKey(
  registry: AuthRegistry,
  opts: { alg: AsymmetricAlg; accessTokenSeconds: number },
): Promise<EnsureAsKeyResult> {
  if (registry.health().state === "lost") return { created: false, skipped: "lost" };
  const existing = activeAsKey(registry);
  if (existing !== undefined) return fromExisting(existing, opts.alg);
  try {
    const rotated = registry.rotateKey({
      purpose: "as",
      alg: opts.alg,
      generated: await generateSigningKey(opts.alg),
      graceSeconds: 0,
      accessTokenSeconds: opts.accessTokenSeconds,
    });
    return { created: true, kid: rotated.kid };
  } catch (e) {
    const raced = activeAsKey(registry);
    if (raced === undefined) throw e;
    return fromExisting(raced, opts.alg);
  }
}

function fromExisting(key: AuthKey, wanted: string): EnsureAsKeyResult {
  return key.alg === wanted
    ? { created: false, kid: key.kid }
    : { created: false, kid: key.kid, skipped: "alg_mismatch", existingAlg: key.alg };
}

const keysOf = (jwks: unknown): unknown[] => {
  const keys = (jwks as { keys?: unknown } | null | undefined)?.keys;
  return Array.isArray(keys) ? keys : [];
};

/** RFC 7638 thumbprint, or undefined for an entry that is not a usable public JWK. */
async function thumbprintOf(jwk: unknown): Promise<string | undefined> {
  if (typeof jwk !== "object" || jwk === null) return undefined;
  try {
    return await calculateJwkThumbprint(jwk as JWK);
  } catch {
    return undefined;
  }
}

/**
 * The kids of `as` registry keys whose public key also appears in `jwks`, matched by RFC 7638
 * thumbprint (not by `kid`, which a JWKS entry can set to anything). A JWKS key is verified under
 * the hand-minted-token rules, so an `as` key listed there would let a token signed with it skip the
 * `as` rules (audience, `at+jwt`, required claims). Empty when nothing overlaps.
 *
 * Only an inline or file JWKS can be checked: a remote `auth.jwksUri` is fetched later and can change
 * at any time, so it is out of reach at boot.
 */
export async function asKeyOverlapInJwks(
  jwks: unknown,
  registry: Pick<AuthRegistry, "listKeys">,
): Promise<string[]> {
  const configured = new Set(
    (await Promise.all(keysOf(jwks).map(thumbprintOf))).filter((t): t is string => t !== undefined),
  );
  if (configured.size === 0) return [];
  const overlap: string[] = [];
  for (const key of registry.listKeys()) {
    if (key.purpose !== "as" || key.publicJwk === null) continue;
    const mine = await thumbprintOf(key.publicJwk);
    if (mine !== undefined && configured.has(mine)) overlap.push(key.kid);
  }
  return overlap;
}

/** Which configured JWKS source overlaps an `as` key, as `auth.jwks` / `auth.jwksFile`. */
export async function configuredJwksOverlap(
  auth: ServerConfig["auth"],
  registry: Pick<AuthRegistry, "listKeys">,
): Promise<{ source: "auth.jwks" | "auth.jwksFile"; kids: string[] } | undefined> {
  if (auth.jwks !== undefined) {
    const kids = await asKeyOverlapInJwks(auth.jwks, registry);
    if (kids.length > 0) return { source: "auth.jwks", kids };
  }
  if (auth.jwksFile) {
    const kids = await asKeyOverlapInJwks(
      JSON.parse(readFileSync(auth.jwksFile, "utf8")),
      registry,
    );
    if (kids.length > 0) return { source: "auth.jwksFile", kids };
  }
  return undefined;
}
