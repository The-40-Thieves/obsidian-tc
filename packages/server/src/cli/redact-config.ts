// Split out of args.ts (THE-636) to stay under biome's noExcessiveLinesPerFile floor — see
// args.ts's re-export comment. `redactConfig` has no coupling to parseCliArgs' logic; it is a
// pure display-time transform used by `config show`.

// Field-name suffixes whose string values are masked in `config show`. A bare `key$` suffix
// subsumes apiKey/api_key/restApiKey and also covers generic credential fields (signingKey,
// privateKey, encryptionKey, …). Err toward over-redaction: masking a non-secret in a
// display-only dump is harmless, leaking a secret is not.
const SECRET_KEY = /(secret|token|password|key)$/i;
// Credential-carrying HTTP header names (H-5): observability.otel.headers.Authorization and
// morgiana.httpHeaders.Cookie hold bearer tokens / session cookies, but their KEYS don't match
// SECRET_KEY, so `config show` printed their values verbatim. Mask by header name too.
// Case-insensitive; over-redaction of a non-secret display value is harmless.
const CREDENTIAL_HEADER =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|api-key)$/i;

// RFC 7517/7518 private members of a JWK: `d` (RSA, EC, OKP), the RSA CRT members `p q dp dq qi`, the
// multi-prime list `oth`, and `k` (the key of an `oct` JWK). They do not look secret by name, so an
// inline `auth.jwks` carrying a private key would print them. Applied only to an object that is a
// JWK (has a string `kty`), so an unrelated field that happens to be called `d` or `k` is untouched.
const JWK_PRIVATE_MEMBER = /^(d|p|q|dp|dq|qi|k|oth)$/;
const isJwk = (v: object): boolean => typeof (v as { kty?: unknown }).kty === "string";

/** Deep-clone a value with secret-looking string fields masked, for `config show`. */
export function redactConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfig);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    const jwk = isJwk(value);
    for (const [k, v] of Object.entries(value)) {
      out[k] =
        (jwk && JWK_PRIVATE_MEMBER.test(k) && v !== undefined && v !== null) ||
        (typeof v === "string" && v.length > 0 && (SECRET_KEY.test(k) || CREDENTIAL_HEADER.test(k)))
          ? "<redacted>"
          : redactConfig(v);
    }
    return out;
  }
  return value;
}
