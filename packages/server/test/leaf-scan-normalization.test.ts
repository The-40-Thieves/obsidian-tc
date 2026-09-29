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
import { enforceMemoryDefense } from "../src/experiential/memory-defense";
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
