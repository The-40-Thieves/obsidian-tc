// Differential test for the PEM private-key scanner in experiential/redact.ts.
//
// `redactPrivateKeys` replaced a bounded regex with a single forward pass (and then a hand-scanned
// marker match, so the ReDoS gate has no pattern to flag). The contract was "what it matches and
// redacts is unchanged", so the regex stays here as the REFERENCE and a seeded generator of
// adversarial shapes asserts the two agree on output text, redaction count and per-id matches.
//
// The generator is fixed-seed, so a failure reproduces; a failing case prints its index and input.

import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/experiential/redact";

const REFERENCE =
  /-----BEGIN [A-Z ]{0,64}PRIVATE KEY-----[\s\S]{0,16384}?-----END [A-Z ]{0,64}PRIVATE KEY-----/g;

/** The pre-rewrite behaviour: the regex first (it was the first pattern), then every other pattern
 *  exactly as the live scanner runs them. */
function reference(text: string) {
  let hits = 0;
  const first = text.replace(REFERENCE, () => {
    hits += 1;
    return "[REDACTED]";
  });
  const rest = redactSecrets(first, { excludeIds: ["private_key"] });
  const matches: Record<string, number> = { ...rest.matches };
  if (hits > 0) matches.private_key = hits;
  return { text: rest.text, redactions: rest.redactions + hits, matches };
}

/** mulberry32: a tiny seeded PRNG, so the corpus is identical on every run and every OS. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LABELS = [
  "",
  "RSA ",
  "EC ",
  "ENCRYPTED ",
  "OPENSSH ",
  `${"A".repeat(64)} `, // 65 chars incl. space: over the bound
  `${"A".repeat(63)} `, // 64 chars: the bound exactly
  "A".repeat(64), // 64 chars, run touches "PRIVATE KEY" with no space
  "A".repeat(65),
  "rsa ", // lowercase: not the label alphabet
  "RSA  ", // double space is in the alphabet
  "RSA-", // hyphen is not
  "RÉSA ", // non-ASCII letter
];
const MARKER_VARIANTS = [
  (kind: "BEGIN" | "END", label: string) => `-----${kind} ${label}PRIVATE KEY-----`,
  (kind: "BEGIN" | "END", label: string) => `-----${kind} ${label}PRIVATE KEY----`, // short rule
  (kind: "BEGIN" | "END", label: string) => `------${kind} ${label}PRIVATE KEY-----`, // long lead rule
  (kind: "BEGIN" | "END", label: string) => `-----${kind} ${label}PRIVATE KEY------`, // long tail
  // Unicode lookalikes for the hyphens: en-dash and fullwidth hyphen-minus.
  (kind: "BEGIN" | "END", label: string) => `–––––${kind} ${label}PRIVATE KEY-----`,
  (kind: "BEGIN" | "END", label: string) => `-----${kind} ${label}PRIVATE KEY－－－－－`,
  (kind: "BEGIN" | "END", label: string) => `-----${kind}\t${label}PRIVATE KEY-----`, // tab, not space
  (kind: "BEGIN" | "END", label: string) => `-----${kind} ${label}PRIVATE  KEY-----`, // split key
];
const BODY_LENGTHS = [0, 1, 64, 16383, 16384, 16385, 16386, 20000];
const SEPARATORS = ["\n", "\r\n", "\r\n\r\n", " ", "", " ", "x"];

function generate(next: () => number): string {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;
  const marker = (kind: "BEGIN" | "END") => {
    // Mostly the canonical form; the variants are the near-misses.
    const variant = next() < 0.65 ? MARKER_VARIANTS[0] : pick(MARKER_VARIANTS);
    const label = next() < 0.5 ? pick(["", "RSA ", "EC "]) : pick(LABELS);
    return (variant as (typeof MARKER_VARIANTS)[number])(kind, label);
  };
  const body = () => {
    const n = next() < 0.5 ? pick(BODY_LENGTHS) : Math.floor(next() * 300);
    const unit = pick(["QUJD", "x", "é", "\u{1f511}", "A\n"]); // astral chars are 2 code units
    return unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  };
  let out = "";
  const parts = 1 + Math.floor(next() * 7);
  for (let i = 0; i < parts; i++) {
    const r = next();
    // BEGIN-heavy, END-light, to reach nested/overlapping BEGINs and a BEGIN after the last END.
    if (r < 0.4) out += marker("BEGIN");
    else if (r < 0.65) out += marker("END");
    else if (r < 0.75) out += "-----BEGIN PRIVATE KEY-----".repeat(1 + Math.floor(next() * 5));
    else out += pick(["", "text ", "token=abcdefgh12345 ", "-----", "BEGIN "]);
    out += pick(SEPARATORS) + body() + pick(SEPARATORS);
  }
  return out;
}

describe("private-key scanner differs from the regex reference nowhere", () => {
  it("agrees with the regex on a fixed-seed adversarial corpus", () => {
    const next = rng(0x1108);
    let withHit = 0;
    for (let i = 0; i < 1000; i++) {
      const input = generate(next);
      const want = reference(input);
      const got = redactSecrets(input);
      // A readable failure: the case index, plus the shape of the input rather than 40 KB of it.
      expect({ i, ...got }, `case ${i} (length ${input.length})`).toEqual({ i, ...want });
      if (want.redactions > 0) withHit += 1;
    }
    // Existence floor: the corpus must actually redact blocks, or "identical" is vacuous.
    expect(withHit).toBeGreaterThan(100);
  });

  it("agrees at the body-length and label-length boundaries, in both directions", () => {
    for (const label of LABELS) {
      for (const n of BODY_LENGTHS) {
        for (const sep of ["", "\r\n"]) {
          const input = `${`-----BEGIN ${label}PRIVATE KEY-----`}${sep}${"a".repeat(n)}${sep}-----END ${label}PRIVATE KEY-----!`;
          expect(redactSecrets(input), `label ${label.length} body ${n}`).toEqual(reference(input));
        }
      }
    }
    // Pin the bound itself, so the corpus above cannot agree by both being wrong the same way:
    // body 16384 redacts, 16385 does not.
    const at = (n: number) =>
      `-----BEGIN PRIVATE KEY-----${"a".repeat(n)}-----END PRIVATE KEY-----`;
    expect(redactSecrets(at(16384)).redactions).toBe(1);
    expect(redactSecrets(at(16385)).redactions).toBe(0);
    const label = (n: number) =>
      `-----BEGIN ${"A".repeat(n)}PRIVATE KEY-----x-----END PRIVATE KEY-----`;
    expect(redactSecrets(label(64)).redactions).toBe(1);
    expect(redactSecrets(label(65)).redactions).toBe(0);
  });

  it("agrees on the named shapes: mismatched labels, nesting, BEGIN after the last END, END only", () => {
    const k = (kind: string, label = "") => `-----${kind} ${label}PRIVATE KEY-----`;
    const cases = [
      `${k("BEGIN", "RSA ")}abc${k("END", "EC ")}`, // mismatched labels
      `${k("BEGIN")}a${k("BEGIN", "RSA ")}b${k("BEGIN", "EC ")}c${k("END")}d${k("END")}`, // nested
      `${k("BEGIN")}a${k("END")}b${k("BEGIN")}c`, // BEGIN after the last END
      `${k("END")}${k("END", "RSA ")}${k("END")}`, // END only
      `${k("BEGIN")}\r\nQUJD\r\n${k("END")}\r\n${k("BEGIN", "EC ")}\r\nQUJD\r\n${k("END", "EC ")}`, // CRLF, two keys
      `–––––BEGIN PRIVATE KEY-----a${k("END")}`, // lookalike BEGIN
      `${k("BEGIN")}a-----END PRIVATE KEY－－－－－`, // lookalike END
      `${k("BEGIN")}${k("BEGIN")}${k("END")}`, // back-to-back BEGINs
      `${k("END")}${k("BEGIN")}${k("END")}`, // END before BEGIN
    ];
    for (const input of cases) expect(redactSecrets(input)).toEqual(reference(input));
  });
});
