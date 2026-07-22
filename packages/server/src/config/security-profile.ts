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
  snapshots: { enabled: true, retention: 20 },
  transports: { http: { enabled: false } },
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
  return mergeProfile(HARDENED_BASE, raw);
}
