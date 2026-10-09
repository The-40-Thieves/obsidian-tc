// THE-526 — named security profiles.
//
// `securityProfile: "hardened"` fills in the least-privilege field set BEFORE schema validation, with
// any explicitly-set field winning, so hardening is one key (plus your own paths) instead of a
// hand-merge of ~6 fields across 4 config sections. "trusted-local" is the permissive default, named
// so an operator can see which posture they are on. The generic profile sets only what is safe to set
// without user input — the readPaths/writePaths in examples/config.hardened.json are illustrative user
// paths and are deliberately left to the operator.

/** The generic hardened posture: everything the profile can set without operator-specific input. */
const HARDENED_BASE: Record<string, unknown> = {
  acl: { strictReadDefault: true },
  writes: { requireCas: true },
  // THE-648: `enabled: true` now matches the schema's own default (trusted-local also snapshots),
  // but stays listed here — explicit, not relied on — because `retention: 20` (vs. the base
  // default of 10) is still hardened-specific and both keys merge as one object.
  snapshots: { enabled: true, retention: 20 },
  transports: { http: { enabled: false } },
  // 2026-08-07: the two CONTENT-capture axes flipped on in the schema (trusted-local now stores
  // secret-scanned call arguments, which is what makes `rerun` usable). Hardened must not inherit
  // that: storing note bodies and search queries is the opposite of least-privilege, and this
  // profile exists to be the restrained posture rather than the current one. Listed explicitly and
  // NOT relied on as a schema default, for the reason THE-648 records two entries above — a
  // default that agrees today can be re-decided tomorrow, and the profile should not move with it.
  experiential: { captureContent: false },
  // A jti-less bearer cannot be revoked individually (only rotating its signing key kills it), so the
  // restrained posture refuses one on every verify path. The schema default stays false for now; it
  // flips at the next major, at which point this line only becomes explicit rather than load-bearing.
  auth: { requireJti: true },
  sessions: { traceContent: false },
};

/** Two-level merge where `override` wins. Nested plain objects merge one level deep; every other
 *  value (including arrays) from `override` REPLACES the base — an explicit path array never
 *  concatenates with the profile's. */
function mergeProfile(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, ov] of Object.entries(override)) {
    const bv = out[key];
    if (isPlainObject(bv) && isPlainObject(ov)) {
      out[key] = { ...bv, ...ov }; // one level: override's keys win, base's unset keys survive
    } else {
      out[key] = ov;
    }
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Apply the named security profile to a raw config object (pre-validation). Returns a new object; the
 * input is not mutated. Explicit fields in `raw` override the profile. "trusted-local" / absent is a
 * no-op — the schema defaults already are the trusted-local posture.
 */
export function applySecurityProfile(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw.securityProfile !== "hardened") return raw;
  // Profile is the BASE; the operator's raw config overrides it.
  return forceDynamicRegistrationOff(mergeProfile(HARDENED_BASE, raw));
}

/**
 * Dynamic Client Registration is the one `hardened` setting an explicit value does NOT override: it
 * opens an unauthenticated client-creation surface (design v2 section 5), so the restrained posture
 * never serves it, and a config that sets both reads `false`. `requestsDynamicRegistration` is how
 * the loader tells the operator.
 */
function forceDynamicRegistrationOff(cfg: Record<string, unknown>): Record<string, unknown> {
  const auth = cfg.auth;
  if (!isPlainObject(auth) || !isPlainObject(auth.as) || auth.as.dynamicRegistration !== true) {
    return cfg;
  }
  return { ...cfg, auth: { ...auth, as: { ...auth.as, dynamicRegistration: false } } };
}

/** Did this raw config ask for DCR under the hardened profile (which then ignores it)? */
export function requestsDynamicRegistration(raw: Record<string, unknown>): boolean {
  const auth = raw.auth;
  return (
    raw.securityProfile === "hardened" &&
    isPlainObject(auth) &&
    isPlainObject(auth.as) &&
    auth.as.dynamicRegistration === true
  );
}
