// Credential redaction, shared by every capture surface.
//
// Lifted out of `experiential/episodes.ts` by THE-736 rather than imported from it. The trace
// capture path lives under `mcp/registry/`, and importing the episode module from there creates a
// cycle that `check:boundaries` rejects (baseline 0). CLAUDE.md names this exact remedy: lift the
// shared helper into a third module instead of having the new consumer import from the old owner.
//
// ONE scanner, deliberately. A pattern added because it leaked through an episode must protect a
// trace too — two copies would drift, and the drift would be silent in the direction that matters.
//
// GH #994: every pattern carries a stable `id` now, so a caller (memory-defense.ts's `block` mode,
// and the `obsidian_tc_memory_defense_hits_total` counter) can name WHICH pattern matched without a
// second, hand-kept list of pattern names — the exhaustiveness that keeps this "the ONE scanner"
// would be lost the moment a second enum of pattern identifiers existed beside this one.

type SecretPattern =
  | { id: string; pattern: RegExp }
  // A pattern one regex cannot scan in linear time (see `redactPrivateKeys`): it owns its
  // replacement loop and calls `hit()` once per redaction for the replacement text.
  | { id: string; redact: (text: string, hit: () => string) => string };

// Longest body between a PEM BEGIN and END marker, counted in UTF-16 code units (`string.length`),
// not bytes. 16384 covers a 4096-bit key's base64 body with room to spare; a body longer than that
// is not a key this scanner was written to catch.
const PEM_BODY_MAX = 16384;
const PEM_BEGIN_PREFIX = "-----BEGIN ";
const PEM_END_PREFIX = "-----END ";
const PEM_KEY_LABEL = "PRIVATE KEY";
const PEM_RULE = "-----";
// Longest label before "PRIVATE KEY" ("ENCRYPTED ", "RSA ", "EC " are the real ones).
const PEM_LABEL_MAX = 64;

/** End offset of a `<prefix>[A-Z ]{0,64}PRIVATE KEY-----` marker starting exactly at `at`, or -1.
 *  Hand-scanned rather than a regex so the fail-closed ReDoS gate (scripts/check-redos.mjs) has no
 *  pattern here to second-guess: the label alphabet `[A-Z ]` contains every character of
 *  "PRIVATE KEY" and not "-", so the label run ends at the first other character and "PRIVATE KEY"
 *  must be its last 11 characters. That makes the check one bounded walk, never a backtrack. */
function pemMarkerEnd(text: string, at: number, prefix: string): number {
  const labelStart = at + prefix.length;
  const limit = Math.min(text.length, labelStart + PEM_LABEL_MAX + PEM_KEY_LABEL.length);
  let run = labelStart;
  while (run < limit) {
    const c = text.charCodeAt(run);
    if (c !== 32 && (c < 65 || c > 90)) break;
    run += 1;
  }
  const keyStart = run - PEM_KEY_LABEL.length;
  if (keyStart < labelStart || !text.startsWith(PEM_KEY_LABEL, keyStart)) return -1;
  return text.startsWith(PEM_RULE, run) ? run + PEM_RULE.length : -1;
}

/** Start of the first valid `prefix` marker at or after `from`, with its end in `endOut[0]`;
 *  -1 when none. Candidates are at least `prefix.length` apart (the prefix has no self-overlap) and
 *  each costs at most 75 characters, so a search is linear in the text it covers. */
function findPemMarker(text: string, prefix: string, from: number, endOut: number[]): number {
  for (let at = text.indexOf(prefix, from); at !== -1; at = text.indexOf(prefix, at + 1)) {
    const end = pemMarkerEnd(text, at, prefix);
    if (end !== -1) {
      endOut[0] = end;
      return at;
    }
  }
  return -1;
}

/** Redact `BEGIN ... PRIVATE KEY` through the nearest `END ... PRIVATE KEY` at most
 *  `PEM_BODY_MAX` UTF-16 code units after it, in ONE forward pass.
 *
 *  The regex form, `BEGIN[\s\S]{0,16384}?END`, is bounded but not cheap: on input that repeats
 *  the BEGIN marker with no END, every BEGIN re-walks its whole 16 KB window before failing, so
 *  the cost is BEGIN count x 16384 (~600 steps per input byte, ~2 ms per KB) and it measured
 *  3.1-3.5x per doubling on a windows runner. Here the next END is searched for ONCE and kept:
 *  every later BEGIN before that END reuses it, and once no END remains every later BEGIN fails
 *  without scanning. Matches are the regex's: the nearest END starting within the bound of the
 *  BEGIN's end, scanning resumes after a match, and a failed BEGIN resumes one character on.
 *  test/redact-private-key-differential.test.ts holds the regex as a reference and diffs the two. */
function redactPrivateKeys(text: string, hit: () => string): string {
  let out = "";
  let copied = 0; // text[0..copied) is already accounted for in `out`
  let endStart = -1; // start of the first END at or after the last search origin; Infinity = none
  let endLen = 0;
  const markerEnd = [0];
  let from = 0;
  for (;;) {
    const begin = findPemMarker(text, PEM_BEGIN_PREFIX, from, markerEnd);
    if (begin === -1) break;
    const bodyStart = markerEnd[0] as number;
    if (endStart < bodyStart) {
      const end = findPemMarker(text, PEM_END_PREFIX, bodyStart, markerEnd);
      endStart = end === -1 ? Number.POSITIVE_INFINITY : end;
      endLen = end === -1 ? 0 : (markerEnd[0] as number) - end;
    }
    if (endStart - bodyStart > PEM_BODY_MAX) {
      from = begin + 1; // no END in reach: this BEGIN opens no block
      continue;
    }
    out += text.slice(copied, begin) + hit();
    copied = endStart + endLen;
    from = copied;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

const SECRET_PATTERNS: SecretPattern[] = [
  // BOUNDED on purpose (CodeQL js/polynomial-redos, high). The unbounded form
  //   /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
  // backtracks polynomially on input that repeats the BEGIN marker without ever supplying an
  // END: the lazy body rescans forward from every start position. That input is reachable --
  // `captureArgs` runs this scanner over the caller's raw arguments BEFORE the size cap, so the
  // text is attacker-controlled and unbounded at this point. The cap cannot move earlier without
  // reintroducing the split-secret problem it exists to prevent, so the BOUND belongs here.
  //
  // Both bounds hold: 64 covers every real PEM label ("ENCRYPTED ", "RSA ", "EC "), 16384 code
  // units the body. The bounded regex was still ~600 steps per input byte on that input, so the
  // scan is `redactPrivateKeys`, a single pass with the same two bounds.
  { id: "private_key", redact: redactPrivateKeys },
  { id: "aws_access_key_id", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g }, // fine/classic tokens
  { id: "github_pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { id: "slack_token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: "openai_key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  {
    id: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
  },
  { id: "bearer_token", pattern: /\bBearer\s+[A-Za-z0-9._-]{16,}\b/g },
  {
    id: "labeled_secret",
    pattern:
      /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token)\s*[=:]\s*["']?[^\s"',;]{8,}/gi,
  },
  // DB/service connection string with embedded user:pass — common schemes only (not a generic
  // `scheme://user:pass@host` catch-all, which would over-match arbitrary URLs unrelated to
  // credential storage).
  {
    id: "db_connection_string",
    pattern:
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps|mssql):\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+/gi,
  },
  { id: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g }, // fixed 39-char shape
  {
    id: "stripe_key",
    pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, // not pk_ — publishable is not a secret
  },
  // Hugging Face token: `hf_` + 30+ alphanumeric. Boundaries are lookaround on the token's own
  // alphabet, not `\b` — `_` is a word character, so a trailing/leading `_` (env-style
  // `hf_...token..._`, or markdown emphasis `_hf_..._`) would silently defeat a `\b`-anchored
  // match (THE-619 defect 3). `{30,}` is a deliberately permissive floor, not the exact 34-char
  // shape Gitleaks models upstream — HF has not published a stable length, and for a redactor a
  // false negative (leaked live credential) is far worse than a false positive (one redacted
  // string) (THE-619 defect 4).
  { id: "huggingface_token", pattern: /(?<![A-Za-z0-9])hf_[A-Za-z0-9]{30,}(?![A-Za-z0-9])/g },
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
  {
    id: "azure_sas_token",
    pattern: /(?:[?&]|%3F|%26)sig(?:=|%3D)(?:[A-Za-z0-9+/_-]|%2B|%2F|%3D){40,}/gi,
  },
];

const REDACTED = "[REDACTED]";

/** The result of a scan: the (possibly redacted) text, how many total hits, and hits broken down
 *  by pattern id — GH #994 needs the id breakdown to name a matched pattern (block mode's error
 *  details) and to tag `obsidian_tc_memory_defense_hits_total` without a content-bearing label. */
export interface RedactScanResult {
  text: string;
  redactions: number;
  matches: Record<string, number>;
}

/** Redact credential-shaped substrings. Returns the scrubbed text, how many hits, and which
 *  pattern ids matched. `matches` is additive (GH #994) — every existing caller destructures only
 *  `{ text, redactions }`, so this stays backward compatible.
 *
 * `opts.excludeIds` skips the named pattern(s) entirely for this call — memory-defense.ts's
 * array-join scan uses it to omit `labeled_secret` (whose FP carve-out for an accidental
 * label/value adjacency across array elements needs to leave the join's bytes untouched for
 * every OTHER pattern, rather than mutating them, which used to blind patterns like
 * `private_key` that legitimately need to bridge the same join). */
export function redactSecrets(
  text: string,
  opts: { excludeIds?: readonly string[] } = {},
): RedactScanResult {
  let out = text;
  let redactions = 0;
  const matches: Record<string, number> = {};
  const excluded = new Set(opts.excludeIds ?? []);
  for (const sp of SECRET_PATTERNS) {
    if (excluded.has(sp.id)) continue;
    const hit = (): string => {
      redactions += 1;
      matches[sp.id] = (matches[sp.id] ?? 0) + 1;
      return REDACTED;
    };
    out = "redact" in sp ? sp.redact(out, hit) : out.replace(sp.pattern, hit);
  }
  return { text: out, redactions, matches };
}

// GH #994 — optional PII scan for memory-defense's `pii: true`. Deliberately narrow: US SSN SHAPE
// and Luhn-valid 13-19 digit numbers with a known card-issuer prefix. Emails and phone numbers are
// never flagged — a personal memory store legitimately holds the owner's own contact details, and
// flagging them would make `pii: true` unusable. Kept in this file (not a second pattern list
// elsewhere) so "the ONE scanner" still describes the whole credential+PII surface memory-defense
// scans, not two files that could drift apart.

// 3-2-4 digit groups, which is what keeps this from ever matching a phone number (3-3-4) or an
// ISO date (4-2-2, and its first group is 4 digits so \d{3}- never even starts matching one). The
// negative lookaheads exclude the SSA's own reserved/invalid area (000, 666, 900-999), group
// (00), and serial (0000) ranges — a shape check, not full SSA validity, but enough to skip the
// obviously-fake examples a redaction test suite reaches for.
const SSN_PATTERN = /\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g;

// A candidate digit run, 13-19 digits after separators are stripped, allowing a single space or
// dash between digits (the common human-typed/grouped shape). Bounded quantifier — no ReDoS risk.
const CARD_CANDIDATE_PATTERN = /\b\d(?:[ -]?\d){12,18}\b/g;

// Issuer prefixes checked against the separator-stripped digit string. Deliberately rough (not a
// full BIN range table) — false negatives here just mean scanPii misses an exotic issuer, which is
// no worse than not having this check at all; false positives are bounded separately by the Luhn
// checksum below.
const ISSUER_PREFIXES: RegExp[] = [
  /^4/, // Visa
  /^(?:5[1-5]|222[1-9]|22[3-9]\d|2[3-6]\d{2}|270\d|271\d|2720)/, // Mastercard
  /^3[47]/, // American Express
  /^(?:6011|65|64[4-9]|622)/, // Discover
];

function hasKnownIssuerPrefix(digits: string): boolean {
  return ISSUER_PREFIXES.some((p) => p.test(digits));
}

/** Standard Luhn checksum over a digit string (no separators). */
function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Scan for PII: US SSN shape + Luhn-valid card numbers with a known issuer prefix. Same result
 *  shape as redactSecrets, with pattern ids `ssn` and `credit_card`. Never scans anything but the
 *  text handed to it — callers are responsible for only ever calling this over tool-arg strings,
 *  never over vectors or caches (a long digit run there can pass Luhn by chance). */
export function scanPii(text: string): RedactScanResult {
  let out = text;
  let redactions = 0;
  const matches: Record<string, number> = {};
  out = out.replace(SSN_PATTERN, () => {
    redactions += 1;
    matches.ssn = (matches.ssn ?? 0) + 1;
    return REDACTED;
  });
  out = out.replace(CARD_CANDIDATE_PATTERN, (m) => {
    const digits = m.replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19) return m;
    if (!hasKnownIssuerPrefix(digits) || !luhnValid(digits)) return m;
    redactions += 1;
    matches.credit_card = (matches.credit_card ?? 0) + 1;
    return REDACTED;
  });
  return { text: out, redactions, matches };
}
