// GH #994 follow-up, item 4 — dedicated tests for memory-defense.ts's leaf-scanner ceiling:
// NFKC + zero-width normalization (applied only to the scanning copy, never persisted unless
// something actually matched) and the array-join scan (a string array joined "\n" the same way
// entities.ts's serializeObservations persists it; a number/bigint array joined with no
// separator, matching its natural persisted numeric-literal form).
//
// Every secret/PII value below is assembled at runtime from pieces that are not individually
// secret-shaped, matching test/memory-defense.test.ts's house rule — this file follows the same
// convention even though a Unicode-spliced or array-split fixture is already unlikely to trip a
// literal-secret scanner.

import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { enforceMemoryDefense, INVISIBLE_SPLICE_RANGES } from "../src/experiential/memory-defense";
import { type M5Vault, makeM5Vault } from "./m5-helpers";

function un<T>(r: { ok: boolean; data?: unknown }): T {
  return (r as { data: T }).data;
}

function expectSecretDetected(fn: () => void): void {
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = true;
    expect(e).toBeInstanceOf(ObsidianTcError);
    if (e instanceof ObsidianTcError) expect(e.code).toBe("secret_detected");
  }
  expect(threw, "expected a secret_detected refusal").toBe(true);
}

describe("leaf-scan normalization — zero-width splicing", () => {
  it("block mode: a zero-width-spliced openai-shaped secret is caught (ZWSP inside the sk- prefix defeats the raw regex, not the normalized scan)", () => {
    // Raw text does NOT match `\bsk-[A-Za-z0-9_-]{20,}\b` — a ZERO WIDTH SPACE (U+200B) sits
    // between "sk-" and the body, which is not in the pattern's character class.
    const zwsp = "​";
    const spliced = ["sk-", zwsp, "Q7w8E9r0T1y2U3i4O5p6A7s8D9f0G1h2"].join("");
    expectSecretDetected(() => {
      enforceMemoryDefense({ mode: "block", pii: false }, { text: spliced });
    });
  });

  it("redact mode: the normalized (zero-width-stripped) form is what gets redacted, never left splice-intact", () => {
    const zwsp = "​";
    const spliced = ["sk-", zwsp, "Q7w8E9r0T1y2U3i4O5p6A7s8D9f0G1h2"].join("");
    const out = enforceMemoryDefense({ mode: "redact", pii: false }, { text: spliced });
    expect(out.redactions).toBeGreaterThan(0);
    expect(out.fields.text).toBe("[REDACTED]");
  });
});

describe("leaf-scan normalization — NFKC homoglyph folding", () => {
  it("block mode: a full-width ('ＡＫＩＡ') AWS-key-shaped secret is caught via NFKC normalization", () => {
    // Full-width Latin capital letters (U+FF21 'Ａ', U+FF2B 'Ｋ', U+FF29 'Ｉ') — NFKC folds these
    // to plain ASCII "AKIA" before the aws_access_key_id pattern ever sees the text; raw, they do
    // not match `\bAKIA[0-9A-Z]{16}\b` at all (different codepoints entirely).
    const fullWidthAkia = "ＡＫＩＡ";
    const spliced = [fullWidthAkia, "Q7W8E9R0T1Y2U3I4"].join("");
    expectSecretDetected(() => {
      enforceMemoryDefense({ mode: "block", pii: false }, { text: spliced });
    });
  });

  it("redact mode: a clean full-width string with no embedded secret is NOT rewritten to its NFKC form", () => {
    // Ordinary full-width prose (no secret pattern anywhere) — this must survive byte-identical:
    // normalization is scan-only, never applied to a leaf's persisted value unless something
    // actually matched.
    const fullWidthGreeting = "ＨＩ ＴＥＡＭ"; // "HI TEAM" full-width
    const out = enforceMemoryDefense({ mode: "redact", pii: false }, { text: fullWidthGreeting });
    expect(out.redactions).toBe(0);
    expect(out.fields.text).toBe(fullWidthGreeting);
  });
});

describe("leaf-scan normalization — array-join scan (string arrays)", () => {
  it("block mode: a PEM private key split across 3 array entries is caught ONLY via the joined scan (no single element matches alone)", () => {
    const beginLine = "-----BEGIN PRIVATE KEY-----";
    const bodyLine = [
      "MIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT4wggE6AgEAAkEAy8Dbv8prpJ",
      "/0kKhlGeJYozo2lTiPz2u1UZVMV8HeLB2rzDsEwCcOZv3nGm14zN4qzFpF",
    ].join("");
    const endLine = "-----END PRIVATE KEY-----";
    // Each element alone: no BEGIN+END pair, so the private_key pattern cannot match it in
    // isolation — confirmed by scanning each individually first.
    for (const el of [beginLine, bodyLine, endLine]) {
      const solo = enforceMemoryDefense({ mode: "block", pii: false }, { text: el });
      expect(solo.redactions, `"${el}" must not match alone`).toBe(0);
    }
    expectSecretDetected(() => {
      enforceMemoryDefense(
        { mode: "block", pii: false },
        { pem_lines: [beginLine, bodyLine, endLine] },
      );
    });
  });

  it("redact mode: every element of the reassembled array is severed to [REDACTED], not left as clean-looking halves that still round-trip into the secret", () => {
    const beginLine = "-----BEGIN PRIVATE KEY-----";
    const bodyLine = "MIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT4wggE6AgEAAkEAy8Dbv8prpJ";
    const endLine = "-----END PRIVATE KEY-----";
    const out = enforceMemoryDefense(
      { mode: "redact", pii: false },
      { pem_lines: [beginLine, bodyLine, endLine] },
    );
    expect(out.redactions).toBeGreaterThan(0);
    expect(out.fields.pem_lines).toStrictEqual(["[REDACTED]", "[REDACTED]", "[REDACTED]"]);
  });
});

describe("leaf-scan normalization — array-join scan (numeric arrays, PII)", () => {
  // Luhn validity of the concatenated digit string ("4234567890123456") confirmed exactly with
  // codecalc (not eyeballed) before writing this fixture.
  const cardGroups = [4234, 5678, 9012, 3456];

  it("block mode: a Luhn-valid PAN split across 4 number-array entries is caught with pii:true, and NOT caught with pii:false", () => {
    // No single group (4234, 5678, 9012, 3456) is itself a 13-19 digit run, so nothing can match
    // per-element — only the no-separator-joined concatenation reassembles the valid PAN.
    for (const n of cardGroups) {
      const solo = enforceMemoryDefense({ mode: "block", pii: true }, { text: n });
      expect(solo.redactions, `${n} must not match alone`).toBe(0);
    }
    // pii: false — scanPii never runs, so the reassembled PAN is not even scanned for.
    const offResult = enforceMemoryDefense(
      { mode: "block", pii: false },
      { card_groups: cardGroups },
    );
    expect(offResult.redactions).toBe(0);

    expectSecretDetected(() => {
      enforceMemoryDefense({ mode: "block", pii: true }, { card_groups: cardGroups });
    });
  });

  it("redact mode: the reassembled numeric array is severed to [REDACTED] strings", () => {
    const out = enforceMemoryDefense({ mode: "redact", pii: true }, { card_groups: cardGroups });
    expect(out.redactions).toBeGreaterThan(0);
    expect(out.fields.card_groups).toStrictEqual([
      "[REDACTED]",
      "[REDACTED]",
      "[REDACTED]",
      "[REDACTED]",
    ]);
  });
});

describe("leaf-scan normalization — a clean leaf is never rewritten", () => {
  it("enforceMemoryDefense: a clean string leaf's normalized form is never what gets returned — original bytes only", () => {
    // A zero-width character sitting in ordinary prose with no secret anywhere near it — the
    // normalized (stripped) copy is used ONLY to scan; since nothing matches, the ORIGINAL bytes
    // (zero-width char intact) must be what's returned, never the normalized copy.
    const zwsp = "​";
    const prose = ["Remember to check the", zwsp, "deploy log tomorrow."].join(" ");
    const out = enforceMemoryDefense({ mode: "redact", pii: true }, { text: prose });
    expect(out.redactions).toBe(0);
    expect(out.fields.text).toBe(prose);
  });

  it("end-to-end: a clean note observation persists byte-identical through a real vault write (create_entity -> get_entity)", async () => {
    let v: M5Vault | undefined;
    try {
      v = makeM5Vault({ memoryDefense: { mode: "block", pii: true } });
      const zwsp = "​";
      const clean = ["Deploy went", zwsp, "fine, no issues to report."].join(" ");
      const r = await v.call("create_entity", {
        vault: "test",
        type: "person",
        name: "clean-leaf-byte-identical-probe",
        observations: [clean],
      });
      expect(r.ok).toBe(true);
      const entityId = un<{ entity_id: string }>(r).entity_id;
      const get = await v.call("get_entity", { vault: "test", entity_id: entityId });
      expect(get.ok).toBe(true);
      const observations = un<{ observations: Array<{ text: string }> }>(get).observations;
      expect(observations[0]?.text).toBe(clean);
    } finally {
      v?.cleanup();
    }
  });
});

// Security review round (HIGH #1): ZERO_WIDTH_RE was widened from a narrow set (ZWSP/ZWNJ/ZWJ
// U+200B-200D, WORD JOINER U+2060, BOM U+FEFF) to also cover the LTR/RTL marks (U+200E-200F), the
// remaining invisible math operators (U+2061-2064), and the bidi embedding/override/isolate
// controls (U+202A-202E, U+2066-2069). The ORIGINAL security-review commit message additionally
// claimed the OLD regex "silently swept in em/en dash, curly quotes, ellipsis, bullets
// (U+2010-U+2027)" — checked against the shipped regex by direct byte inspection and NOT borne
// out: that range was never part of the old character class (see memory-defense.ts's own comment
// on ZERO_WIDTH_RE for the corrected account). The genuine defect was UNDER-coverage: verified
// empirically that a secret spliced with U+200E (LTR MARK) — not in the old set — went completely
// uncaught (0 redactions). That is the RED case below; the punctuation-preservation tests that
// follow are legitimate regression coverage (this widening must not start over-matching ordinary
// punctuation either) but do not correspond to a bug that ever shipped.
describe("leaf-scan normalization — widened zero-width coverage (security review round HIGH #1)", () => {
  it("block mode: a secret spliced with U+200E (LTR MARK, outside the OLD narrow set) is caught", () => {
    const ltrMark = "‎";
    const spliced = ["sk-", ltrMark, "Q7w8E9r0T1y2U3i4O5p6A7s8D9f0G1h2"].join("");
    expectSecretDetected(() => {
      enforceMemoryDefense({ mode: "block", pii: false }, { text: spliced });
    });
  });

  it("block mode: a secret spliced with U+2066 (LEFT-TO-RIGHT ISOLATE, outside the OLD narrow set) is caught", () => {
    const lri = "⁦";
    const spliced = ["sk-", lri, "Q7w8E9r0T1y2U3i4O5p6A7s8D9f0G1h2"].join("");
    expectSecretDetected(() => {
      enforceMemoryDefense({ mode: "block", pii: false }, { text: spliced });
    });
  });

  it("redact mode: the U+200E-spliced form is what gets redacted, never left splice-intact", () => {
    const ltrMark = "‎";
    const spliced = ["sk-", ltrMark, "Q7w8E9r0T1y2U3i4O5p6A7s8D9f0G1h2"].join("");
    const out = enforceMemoryDefense({ mode: "redact", pii: false }, { text: spliced });
    expect(out.redactions).toBeGreaterThan(0);
    expect(out.fields.text).toBe("[REDACTED]");
  });

  // Ellipsis (U+2026) is deliberately NOT in this table: `normalize("NFKC")` — applied to the
  // whole leaf whenever anything in it matches — has its OWN, unrelated compatibility
  // decomposition for U+2026 into three U+002E FULL STOPs ("..."). That is normalization doing
  // its documented job, not a zero-width-stripping bug; it gets its own assertion below instead
  // of the byte-identical one.
  const punctuationCases: Array<{ label: string; ch: string }> = [
    { label: "em dash (U+2014)", ch: "—" },
    { label: "en dash (U+2013)", ch: "–" },
    { label: "left curly single quote (U+2018)", ch: "‘" },
    { label: "right curly single quote (U+2019)", ch: "’" },
    { label: "left curly double quote (U+201C)", ch: "“" },
    { label: "right curly double quote (U+201D)", ch: "”" },
    { label: "bullet (U+2022)", ch: "•" },
  ];

  for (const c of punctuationCases) {
    it(`redact mode: a note containing a real secret AND ${c.label} elsewhere keeps that character in the persisted (redacted) text`, () => {
      const zwsp = "​";
      const spliced = ["sk-", zwsp, "Q7w8E9r0T1y2U3i4O5p6A7s8D9f0G1h2"].join("");
      const prose = `Notes ${c.ch} details ${c.ch} more — key ${spliced} rotated ${c.ch} done`;
      const out = enforceMemoryDefense({ mode: "redact", pii: false }, { text: prose });
      expect(out.redactions).toBeGreaterThan(0);
      const persisted = out.fields.text as string;
      expect(persisted).not.toContain("Q7w8E9r0T1y2U3i4O5p6A7s8D9f0G1h2");
      expect(persisted, `${c.label} must survive redaction, not be silently stripped`).toContain(
        c.ch,
      );
    });
  }

  it('redact mode: ellipsis elsewhere in a note with a real secret survives as its NFKC form ("..."), never silently deleted', () => {
    const zwsp = "​";
    const spliced = ["sk-", zwsp, "Q7w8E9r0T1y2U3i4O5p6A7s8D9f0G1h2"].join("");
    const prose = `Notes… details… more — key ${spliced} rotated… done`;
    const out = enforceMemoryDefense({ mode: "redact", pii: false }, { text: prose });
    expect(out.redactions).toBeGreaterThan(0);
    const persisted = out.fields.text as string;
    expect(persisted).not.toContain("Q7w8E9r0T1y2U3i4O5p6A7s8D9f0G1h2");
    // NFKC's compatibility decomposition turns "…" into "...", never into nothing — this must
    // never regress to outright deletion.
    expect(persisted).not.toContain("Notes details more");
    expect(persisted).toContain("...");
  });

  it("block mode: none of these characters, alone or repeated, are themselves treated as a match", () => {
    const allChars = [...punctuationCases.map((c) => c.ch), "…"].join("");
    // "here " (a space) before the repeated run, deliberately — no "label:value" shape anywhere
    // in this prose, so LABELED_SECRET_VALUE_RE cannot mistake it for a labeled credential.
    const prose = `Just punctuation, no credentials here ${allChars.repeat(3)}`;
    const out = enforceMemoryDefense({ mode: "block", pii: false }, { text: prose });
    expect(out.redactions).toBe(0);
    expect(out.fields.text).toBe(prose);
  });
});

// Residual fix — `labeled_secret`'s `\s*[=:]\s*` bridges the "\n" the array-join scan inserts
// between elements, so a label sitting in one element and an unrelated value-looking token in the
// NEXT element (never written as a pair) read as one hit purely because of how the join happens to
// land. Every other pattern that legitimately needs to bridge the join (bearer_token's `\s+`,
// private_key's `[\s\S]`) must keep working — only labeled_secret's own boundary-crossing match is
// the false positive being closed here.
describe("array-join scan — labeled_secret must not span an element boundary (residual fix)", () => {
  it("block mode: a label alone in one element and an ORDINARY (not secret-shaped) word alone in the next is NOT caught via the joined scan", () => {
    // Security review round (finding 3): the original fixture here used a high-confidence
    // secret-shaped value ("AbCdEfGh12345678ZZZZ" — 20 chars, 3+ char classes) and asserted
    // `redactions: 0`, which pinned "we still miss a real secret" as the expected/passing
    // outcome. Replaced with an ordinary word: this test now proves the FP carve-out (an
    // accidental label/value adjacency across array elements is not flagged), not a detection
    // hole.
    const label = "token:";
    const unrelatedWord = "team-standup-notes"; // ordinary id-shaped text, not secret-shaped
    for (const el of [label, unrelatedWord]) {
      const solo = enforceMemoryDefense({ mode: "block", pii: false }, { text: el });
      expect(solo.redactions, `"${el}" must not match alone`).toBe(0);
    }
    const out = enforceMemoryDefense(
      { mode: "block", pii: false },
      { parts: [label, unrelatedWord] },
    );
    expect(out.redactions).toBe(0);
    expect(out.fields.parts).toStrictEqual([label, unrelatedWord]);
  });

  it("redact mode: the same boundary-only pairing leaves the array untouched, not severed to [REDACTED]", () => {
    const label = "password:";
    const unrelatedWord = "wednesday-meeting-agenda";
    const out = enforceMemoryDefense(
      { mode: "redact", pii: false },
      { parts: [label, unrelatedWord] },
    );
    expect(out.redactions).toBe(0);
    expect(out.fields.parts).toStrictEqual([label, unrelatedWord]);
  });

  // Residual fix (finding 3) — the OLD implementation neutralized a cross-boundary labeled_secret
  // match by overwriting its bytes with "x" IN THE JOINED STRING before any other pattern ran,
  // which also destroyed a genuine private_key match spanning the SAME text: `token:\n-----BEGIN`
  // is itself a cross-boundary labeled_secret match (11 non-space chars after the colon), so its
  // bytes — including "-----BEGIN" — were overwritten before the private_key pattern ever saw
  // them. RED against the old strip-and-mutate implementation; GREEN once labeled_secret is
  // excluded from the joined scan instead of the joined text being mutated for every pattern.
  it("block mode: a labeled_secret FP carve-out at one boundary must not blind the private_key pattern to a genuine join elsewhere in the SAME array", () => {
    const beginLine = "-----BEGIN PRIVATE KEY-----";
    const bodyLine = "MIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT4wggE6AgEAAkEAy8Dbv8prpJ";
    const endLine = "-----END PRIVATE KEY-----";
    expectSecretDetected(() => {
      enforceMemoryDefense(
        { mode: "block", pii: false },
        { parts: ["token:", beginLine, bodyLine, endLine] },
      );
    });
  });

  it("redact mode: the same array is still severed to [REDACTED] end to end, not left with a live PEM body", () => {
    const beginLine = "-----BEGIN PRIVATE KEY-----";
    const bodyLine = "MIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT4wggE6AgEAAkEAy8Dbv8prpJ";
    const endLine = "-----END PRIVATE KEY-----";
    const out = enforceMemoryDefense(
      { mode: "redact", pii: false },
      { parts: ["token:", beginLine, bodyLine, endLine] },
    );
    expect(out.redactions).toBeGreaterThan(0);
    expect(out.fields.parts).toStrictEqual([
      "[REDACTED]",
      "[REDACTED]",
      "[REDACTED]",
      "[REDACTED]",
    ]);
  });

  it("block mode: a genuine label=value pair CONTAINED WITHIN one array element is still caught (not a boundary case)", () => {
    const secret = ["access_token", ": ", "kJ8xQ2vR9mN4pL7wT1zY6sB3cH0dF5gA"].join("");
    expectSecretDetected(() => {
      enforceMemoryDefense({ mode: "block", pii: false }, { parts: ["intro", secret, "outro"] });
    });
  });

  it("block mode: bearer_token still bridges an array-join boundary — a genuinely split secret is still caught", () => {
    const tokenBody = "Q7w8E9r0T1y2U3i4O5p6A7s8D9f0G1h2";
    for (const el of ["Bearer", tokenBody]) {
      const solo = enforceMemoryDefense({ mode: "block", pii: false }, { text: el });
      expect(solo.redactions, `"${el}" must not match alone`).toBe(0);
    }
    expectSecretDetected(() => {
      enforceMemoryDefense({ mode: "block", pii: false }, { parts: ["Bearer", tokenBody] });
    });
  });
});

// Residual fix — normalizeForScan's ZERO_WIDTH_RE was missing SOFT HYPHEN (U+00AD) and MONGOLIAN
// VOWEL SEPARATOR (U+180E); a secret spliced with either survived unstripped (0 redactions).
describe("leaf-scan normalization — invisible-splice codepoints not previously stripped (residual fix)", () => {
  it("block mode: a secret spliced with U+00AD (SOFT HYPHEN) is caught", () => {
    const softHyphen = "­";
    const spliced = ["sk-", softHyphen, "Q7w8E9r0T1y2U3i4O5p6A7s8D9f0G1h2"].join("");
    expectSecretDetected(() => {
      enforceMemoryDefense({ mode: "block", pii: false }, { text: spliced });
    });
  });

  it("block mode: a secret spliced with U+180E (MONGOLIAN VOWEL SEPARATOR) is caught", () => {
    const mvs = "᠎";
    const spliced = ["sk-", mvs, "Q7w8E9r0T1y2U3i4O5p6A7s8D9f0G1h2"].join("");
    expectSecretDetected(() => {
      enforceMemoryDefense({ mode: "block", pii: false }, { text: spliced });
    });
  });

  it("redact mode: both spliced forms are what get redacted, never left splice-intact", () => {
    for (const cp of [0x00ad, 0x180e]) {
      const ch = String.fromCodePoint(cp);
      const spliced = ["sk-", ch, "Q7w8E9r0T1y2U3i4O5p6A7s8D9f0G1h2"].join("");
      const out = enforceMemoryDefense({ mode: "redact", pii: false }, { text: spliced });
      expect(out.redactions, `U+${cp.toString(16)} must redact`).toBeGreaterThan(0);
      expect(out.fields.text).toBe("[REDACTED]");
    }
  });

  // Sweeps the SAME array memory-defense.ts exports (INVISIBLE_SPLICE_RANGES) rather than a
  // second hand-typed codepoint list here — this file would silently stop testing a codepoint the
  // moment the production list changed if it kept its own copy.
  it("every codepoint in memory-defense.ts's INVISIBLE_SPLICE_RANGES, spliced into a secret, is caught", () => {
    for (const [lo, hi] of INVISIBLE_SPLICE_RANGES) {
      for (let cp = lo; cp <= hi; cp++) {
        const ch = String.fromCodePoint(cp);
        const spliced = ["sk-", ch, "Q7w8E9r0T1y2U3i4O5p6A7s8D9f0G1h2"].join("");
        expectSecretDetected(() => {
          enforceMemoryDefense({ mode: "block", pii: false }, { text: spliced });
        });
      }
    }
  });
});

// Residual fix (finding 4) — three more invisible/formatting codepoint families never made it
// into INVISIBLE_SPLICE_RANGES: U+061C (ARABIC LETTER MARK, a bidi control the U+200E-200F/
// U+202A-202E/U+2066-2069 additions above should have swept in but did not), U+034F (COMBINING
// GRAPHEME JOINER — zero-width by definition, distinct from the already-covered word joiner
// U+2060), and the 16-codepoint VARIATION SELECTOR block U+FE00-FE0F (renders nothing on its
// own; splices invisibly into a secret exactly like ZWSP). Each is a genuine RED case against the
// pre-fix list — spliced into a secret, none were stripped by normalizeForScan (0 redactions).
describe("leaf-scan normalization — Arabic letter mark, combining grapheme joiner, variation selectors (residual fix)", () => {
  it("block mode: a secret spliced with U+061C (ARABIC LETTER MARK) is caught", () => {
    const alm = "؜";
    const spliced = ["sk-", alm, "Q7w8E9r0T1y2U3i4O5p6A7s8D9f0G1h2"].join("");
    expectSecretDetected(() => {
      enforceMemoryDefense({ mode: "block", pii: false }, { text: spliced });
    });
  });

  it("block mode: a secret spliced with U+034F (COMBINING GRAPHEME JOINER) is caught", () => {
    const cgj = "͏";
    const spliced = ["sk-", cgj, "Q7w8E9r0T1y2U3i4O5p6A7s8D9f0G1h2"].join("");
    expectSecretDetected(() => {
      enforceMemoryDefense({ mode: "block", pii: false }, { text: spliced });
    });
  });

  it("block mode: a secret spliced with U+FE0F (VARIATION SELECTOR-16, within the FE00-FE0F block) is caught", () => {
    const vs16 = "️";
    const spliced = ["sk-", vs16, "Q7w8E9r0T1y2U3i4O5p6A7s8D9f0G1h2"].join("");
    expectSecretDetected(() => {
      enforceMemoryDefense({ mode: "block", pii: false }, { text: spliced });
    });
  });

  it("redact mode: all three spliced forms are what get redacted, never left splice-intact", () => {
    for (const cp of [0x061c, 0x034f, 0xfe0f]) {
      const ch = String.fromCodePoint(cp);
      const spliced = ["sk-", ch, "Q7w8E9r0T1y2U3i4O5p6A7s8D9f0G1h2"].join("");
      const out = enforceMemoryDefense({ mode: "redact", pii: false }, { text: spliced });
      expect(out.redactions, `U+${cp.toString(16)} must redact`).toBeGreaterThan(0);
      expect(out.fields.text).toBe("[REDACTED]");
    }
  });
});
