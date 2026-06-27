import { describe, expect, it } from "vitest";
import { scanSecrets, shannonEntropy } from "../src/search/secrets";

describe("secret scan (W-INGEST pre-embed gate)", () => {
  it("flags credential shapes and reports class names only (never the value)", () => {
    const aws = scanSecrets("aws key AKIAIOSFODNN7EXAMPLE in a note");
    expect(aws.clean).toBe(false);
    expect(aws.classes).toContain("aws_access_key_id");
    expect(aws.classes.join("|")).not.toContain("AKIA"); // value never leaks into classes

    expect(scanSecrets(`token ghp_${"a".repeat(36)}`).classes).toContain("github_token");
    const jwt = "eyJhbGciOiJIUzI1Ni012.eyJzdWIiOiIxMjM0NTY012.SflKxwRJSMeKKF2QT4012";
    expect(scanSecrets(jwt).classes).toContain("jwt");
  });

  it("passes clean prose and entropy-gates low-entropy placeholder assignments", () => {
    expect(scanSecrets("just some normal note content with no secrets").clean).toBe(true);
    // generic assignment whose value is a low-entropy placeholder must not trip.
    expect(scanSecrets(`api_key = "${"a".repeat(24)}"`).clean).toBe(true);
  });

  it("shannonEntropy is 0 for empty and positive for mixed content", () => {
    expect(shannonEntropy("")).toBe(0);
    expect(shannonEntropy("abcd1234XYZ")).toBeGreaterThan(2);
  });
});
