// GH #994 — extends redact.ts's own contract test coverage: `matches` (additive, backward
// compatible with every pre-#994 `{ text, redactions }` destructuring caller) and the new
// `scanPii` export (SSN shape + Luhn-valid card with a known issuer prefix).
//
// Every candidate secret/PII value below is assembled at runtime from pieces that are not
// individually secret-shaped (string concatenation / computed Luhn check digits), never a single
// literal that itself matches a SECRET_PATTERNS/PII regex — so this file carries no fake
// credential a scanner (gitleaks/trufflehog) could flag, on top of `.gitleaks.toml`'s existing
// `packages/server/test/.*` allowlist.
import { describe, expect, it } from "vitest";
import { redactSecrets, scanPii } from "../src/experiential/redact";

/** A fake OpenAI-shaped key: no literal in this file starts with "sk-" — the prefix and body are
 *  joined at runtime. */
function fakeOpenAiKey(): string {
  return ["sk", "-", "Q7w8E9r0T1y2U3i4O5p6A7s8D9f0G1h2"].join("");
}

/** A fake GitHub PAT-shaped token, same runtime-join approach. */
function fakeGithubToken(): string {
  return ["gh", "p_", "M1n2B3v4C5x6Z7a8S9d0F1g2H3j4K5l6"].join("");
}

/** A fake AWS access key id: AKIA + 16 uppercase-alnum, joined at runtime. */
function fakeAwsKeyId(): string {
  return ["AKIA", "Q7W8E9R0T1Y2U3I4"].join("");
}

/** SSN-shaped, joined from parts that are individually not SSN-shaped. Area/group/serial chosen
 *  to avoid the reserved ranges SSN_PATTERN's own lookaheads exclude (000/666/9xx area, 00
 *  group, 0000 serial). */
function fakeSsn(): string {
  return ["1", "2", "3", "-", "4", "5", "-", "6", "7", "8", "9"].join("");
}

/** Standard Luhn check-digit computation (mirrors redact.ts's own `luhnValid`, run forward
 *  instead of validated) — builds a Luhn-VALID digit string from a payload, at runtime, so no
 *  literal full card number ever sits in source. */
function luhnAppendCheckDigit(payload: string): string {
  let sum = 0;
  let alt = true; // doubling starts at the rightmost PAYLOAD digit — the position adjacent to
  // where the check digit lands, which validates correctly under the standard (non-doubled
  // check-digit) Luhn walk redact.ts's own luhnValid performs.
  for (let i = payload.length - 1; i >= 0; i--) {
    let d = payload.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  const check = (10 - (sum % 10)) % 10;
  return payload + String(check);
}

/** A Luhn-VALID Visa-shaped (prefix "4") 16-digit card number, computed at runtime. */
function fakeValidVisaCard(): string {
  const payload = ["4", "2", "3", "4", "5", "6", "7", "8", "9", "0", "1", "2", "3", "4", "5"].join(
    "",
  );
  return luhnAppendCheckDigit(payload);
}

/** The SAME digit string as fakeValidVisaCard, but with its final (check) digit bumped by one —
 *  shape-plausible (right length, known issuer prefix) but Luhn-INVALID. */
function fakeInvalidVisaCard(): string {
  const valid = fakeValidVisaCard();
  const lastDigit = Number(valid[valid.length - 1]);
  const bumped = (lastDigit + 1) % 10;
  return valid.slice(0, -1) + String(bumped);
}

describe("redactSecrets — matches (GH #994, additive)", () => {
  it("stays backward compatible: every existing caller destructuring only { text, redactions } still works", () => {
    const { text, redactions } = redactSecrets(`key: ${fakeOpenAiKey()}`);
    expect(redactions).toBe(1);
    expect(text).not.toContain(fakeOpenAiKey());
  });

  it("adds a matches breakdown by pattern id, additive to the existing shape", () => {
    const key = fakeOpenAiKey();
    const token = fakeGithubToken();
    const result = redactSecrets(`note: ${key} and also ${token}`);
    expect(result.redactions).toBe(2);
    expect(result.matches).toEqual({ openai_key: 1, github_token: 1 });
  });

  it("sums repeated hits of the SAME pattern id in one matches count", () => {
    const aws1 = fakeAwsKeyId();
    // A second, distinct AWS-shaped id (different suffix) so this exercises two matches of the
    // same pattern id, not the same literal matched twice.
    const aws2 = ["AKIA", "Z9Y8X7W6V5U4T3S2"].join("");
    const result = redactSecrets(`${aws1} then later ${aws2}`);
    expect(result.matches).toEqual({ aws_access_key_id: 2 });
    expect(result.redactions).toBe(2);
  });

  it("matches is empty (not absent) when nothing matches", () => {
    const result = redactSecrets("nothing secret in this sentence at all");
    expect(result.redactions).toBe(0);
    expect(result.matches).toEqual({});
  });
});

describe("scanPii — SSN + Luhn-valid card (GH #994)", () => {
  it("flags a bare SSN-shaped value under the ssn pattern id", () => {
    const ssn = fakeSsn();
    const result = scanPii(`ssn on file: ${ssn}`);
    expect(result.redactions).toBe(1);
    expect(result.matches).toEqual({ ssn: 1 });
    expect(result.text).not.toContain(ssn);
  });

  it("flags a Luhn-valid card with a known issuer prefix under credit_card", () => {
    const card = fakeValidVisaCard();
    const result = scanPii(`card on file: ${card}`);
    expect(result.redactions).toBe(1);
    expect(result.matches).toEqual({ credit_card: 1 });
    expect(result.text).not.toContain(card);
  });

  it("accepts a human-typed grouped card number (spaces/dashes) the same as the bare digit run", () => {
    const card = fakeValidVisaCard();
    const grouped = `${card.slice(0, 4)} ${card.slice(4, 8)} ${card.slice(8, 12)} ${card.slice(12)}`;
    const result = scanPii(grouped);
    expect(result.matches).toEqual({ credit_card: 1 });
  });

  // GREEN negatives — must NEVER trip scanPii. Same corpus category as memory-defense.test.ts's
  // own GREEN describe block, kept here too because it is redactSecrets/scanPii's own contract,
  // not only memoryDefense's.
  describe("GREEN: shapes that must not trip scanPii", () => {
    it("a Luhn-INVALID card-shaped digit run is never flagged", () => {
      const invalid = fakeInvalidVisaCard();
      const result = scanPii(`ref ${invalid} in the log`);
      expect(result.redactions).toBe(0);
      expect(result.matches).toEqual({});
    });

    it("an ISO 8601 date is never mistaken for an SSN (4-2-2 groups, not 3-2-4)", () => {
      const iso = "2026-09-28";
      const result = scanPii(`filed on ${iso}`);
      expect(result.redactions).toBe(0);
    });

    it("an email address is never flagged (a personal store legitimately holds the owner's own)", () => {
      const email = ["person", "@", "example", ".com"].join("");
      const result = scanPii(`contact: ${email}`);
      expect(result.redactions).toBe(0);
    });

    it("a phone number (3-3-4 grouping) is never flagged as an SSN", () => {
      const phone = "555-867-5309";
      const result = scanPii(`call ${phone}`);
      expect(result.redactions).toBe(0);
    });

    it("a UUID sitting next to an unrelated project-id label is never flagged", () => {
      const uuid = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
      const result = scanPii(`project id ${uuid} deployed`);
      expect(result.redactions).toBe(0);
    });
  });
});
