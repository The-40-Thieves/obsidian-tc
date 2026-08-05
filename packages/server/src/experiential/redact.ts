// Credential redaction, shared by every capture surface.
//
// Lifted out of `experiential/episodes.ts` by THE-736 rather than imported from it. The trace
// capture path lives under `mcp/registry/`, and importing the episode module from there creates a
// cycle that `check:boundaries` rejects (baseline 0). CLAUDE.md names this exact remedy: lift the
// shared helper into a third module instead of having the new consumer import from the old owner.
//
// ONE scanner, deliberately. A pattern added because it leaked through an episode must protect a
// trace too — two copies would drift, and the drift would be silent in the direction that matters.

export const SECRET_PATTERNS: RegExp[] = [
  // BOUNDED on purpose (CodeQL js/polynomial-redos, high). The unbounded form
  //   /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
  // backtracks polynomially on input that repeats the BEGIN marker without ever supplying an
  // END: the lazy body rescans forward from every start position. That input is reachable —
  // `captureArgs` runs this scanner over the caller's raw arguments BEFORE the size cap, so the
  // text is attacker-controlled and unbounded at this point. The cap cannot move earlier without
  // reintroducing the split-secret problem it exists to prevent, so the BOUND belongs here.
  //
  // Both quantifiers are bounded. 64 covers every real PEM label ("ENCRYPTED ", "RSA ", "EC ");
  // 16384 covers a 4096-bit key's base64 body with room to spare, and a body longer than that is
  // not a key this scanner was written to catch.
  /-----BEGIN [A-Z ]{0,64}PRIVATE KEY-----[\s\S]{0,16384}?-----END [A-Z ]{0,64}PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub fine/classic tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bsk-[A-Za-z0-9_-]{20,}\b/g, // OpenAI-style secret keys
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, // JWT
  /\bBearer\s+[A-Za-z0-9._-]{16,}\b/g,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token)\s*[=:]\s*["']?[^\s"',;]{8,}/gi,
  // DB/service connection string with embedded user:pass — common schemes only (not a generic
  // `scheme://user:pass@host` catch-all, which would over-match arbitrary URLs unrelated to
  // credential storage).
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps|mssql):\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+/gi,
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key (fixed 39-char shape)
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, // Stripe secret/restricted key (not pk_ — publishable is not a secret)
  // Hugging Face token: `hf_` + 30+ alphanumeric. Boundaries are lookaround on the token's own
  // alphabet, not `\b` — `_` is a word character, so a trailing/leading `_` (env-style
  // `hf_...token..._`, or markdown emphasis `_hf_..._`) would silently defeat a `\b`-anchored
  // match (THE-619 defect 3). `{30,}` is a deliberately permissive floor, not the exact 34-char
  // shape Gitleaks models upstream — HF has not published a stable length, and for a redactor a
  // false negative (leaked live credential) is far worse than a false positive (one redacted
  // string) (THE-619 defect 4).
  /(?<![A-Za-z0-9])hf_[A-Za-z0-9]{30,}(?![A-Za-z0-9])/g,
  // Azure SAS token: a `sig=` (or percent-encoded `sig%3D`) query parameter, anchored on real
  // query-string context (`?`/`&`, or their percent-encoded forms `%3F`/`%26` for a SAS URL
  // that has itself been percent-encoded whole — a realistic shape when it arrives inside a
  // JSON args payload on a capture path, THE-619 defect 2). A bare `sig: <value>` with no
  // query-parameter delimiter — e.g. `sig: migration`, `sig=disabled`, or public signature
  // material — is deliberately NOT matched; `sig` is too short/common a key to sit in the
  // generic labeled-value alternation above (THE-619 defect 1, replacing the earlier
  // `sig`-in-alternation approach). Length floor 40: a SAS signature is a Base64-encoded
  // HMAC-SHA256 digest, a fixed 44 chars (32 bytes -> 11 base64 groups + one `=` pad); 40 sits
  // just under that to tolerate percent-encoding of the value itself without hardcoding the
  // exact literal count.
  /(?:[?&]|%3F|%26)sig(?:=|%3D)(?:[A-Za-z0-9+/_-]|%2B|%2F|%3D){40,}/gi,
];

const REDACTED = "[REDACTED]";

/** Redact credential-shaped substrings. Returns the scrubbed text + how many hits. */
export function redactSecrets(text: string): { text: string; redactions: number } {
  let out = text;
  let redactions = 0;
  for (const pat of SECRET_PATTERNS) {
    out = out.replace(pat, () => {
      redactions += 1;
      return REDACTED;
    });
  }
  return { text: out, redactions };
}
