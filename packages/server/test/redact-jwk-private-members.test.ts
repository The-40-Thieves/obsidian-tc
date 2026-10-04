// `config show` masks inline JWK private members. A JWK's private fields (d, p, q, dp, dq, qi for
// RSA/EC/OKP, k for oct, and the multi-prime `oth` array) do not match the secret-name suffix list,
// so an inline `auth.jwks` carrying a private key printed it verbatim.
import { describe, expect, it } from "vitest";
import { redactConfig } from "../src/cli/redact-config";

const SENTINELS = {
  d: "SENTINEL-d-aaaa",
  p: "SENTINEL-p-bbbb",
  q: "SENTINEL-q-cccc",
  dp: "SENTINEL-dp-dddd",
  dq: "SENTINEL-dq-eeee",
  qi: "SENTINEL-qi-ffff",
  k: "SENTINEL-k-gggg",
};
const PUBLIC = { kty: "RSA", kid: "pub-kid", use: "sig", alg: "RS256", n: "PUBLIC-n", e: "AQAB" };

describe("redactConfig on inline JWKs", () => {
  it("masks every private member of an RSA JWK and keeps the public ones", () => {
    const shown = JSON.stringify(
      redactConfig({ auth: { jwks: { keys: [{ ...PUBLIC, ...SENTINELS }] } } }),
    );
    for (const v of Object.values(SENTINELS)) expect(shown).not.toContain(v);
    for (const v of ["pub-kid", "PUBLIC-n", "AQAB", "RS256"]) expect(shown).toContain(v);
    expect(shown).toContain('"d":"<redacted>"');
  });

  it("masks `k` of a symmetric (oct) JWK and a bare JWK outside a keys array", () => {
    const shown = JSON.stringify(
      redactConfig({ oidc: { jwk: { kty: "oct", kid: "sym", k: SENTINELS.k } } }),
    );
    expect(shown).not.toContain(SENTINELS.k);
    expect(shown).toContain("sym");
  });

  it("masks the `oth` multi-prime entries", () => {
    const shown = JSON.stringify(
      redactConfig({
        jwk: {
          kty: "RSA",
          n: "n",
          e: "e",
          d: "x",
          oth: [{ r: "R-secret", d: "D-secret", t: "T-secret" }],
        },
      }),
    );
    for (const v of ["R-secret", "D-secret", "T-secret"]) expect(shown).not.toContain(v);
  });

  it("does not touch ordinary config that merely has fields named d, p, q or k", () => {
    const cfg = { vaults: [{ id: "v1", path: "/p", d: "keep", k: "keep-too" }], plain: { p: "x" } };
    expect(redactConfig(cfg)).toEqual(cfg);
  });

  it("is idempotent and leaves a JWKS with only public keys unchanged", () => {
    const cfg = { auth: { jwks: { keys: [PUBLIC] } } };
    expect(redactConfig(cfg)).toEqual(cfg);
  });
});
