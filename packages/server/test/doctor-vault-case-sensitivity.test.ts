// vaults.case-sensitivity — the doctor check that surfaces each vault's resolved case behavior.
// Pure view in, CheckResult out (no filesystem): the probe itself is covered by
// acl-per-vault-case.test.ts through buildAcls.
import { describe, expect, it } from "vitest";
import {
  type VaultCaseSensitivityView,
  vaultCaseSensitivityCheck,
} from "../src/doctor/vault-case-sensitivity";
import type { VaultCaseInfo } from "../src/vault/case-sensitivity";

const probed = (caseInsensitive: boolean): VaultCaseInfo => ({
  configured: "auto",
  detected: caseInsensitive,
  caseInsensitive,
  match: { allow: caseInsensitive, rules: caseInsensitive },
});
const overridden = (caseSensitive: boolean): VaultCaseInfo => ({
  configured: caseSensitive,
  detected: null,
  caseInsensitive: !caseSensitive,
  match: { allow: !caseSensitive, rules: !caseSensitive },
});
const UNKNOWN: VaultCaseInfo = {
  configured: "auto",
  detected: null,
  caseInsensitive: null,
  match: { allow: false, rules: true },
};

const run = async (vaults: VaultCaseSensitivityView["vaults"]) =>
  await vaultCaseSensitivityCheck({ vaults }).run({ serverVersion: "0.0.0-test" });

describe("vaults.case-sensitivity", () => {
  it("is ok when every vault's case behavior is known, and says what each resolved to", async () => {
    const result = await run([
      { id: "main", info: probed(true) },
      { id: "code", info: probed(false) },
      { id: "pinned", info: overridden(false) },
    ]);
    expect(result.status).toBe("ok");
    expect(result.details?.vaults).toEqual([
      "main: case-insensitive, probed",
      "code: case-sensitive, probed",
      "pinned: case-insensitive, configured: caseSensitive false",
    ]);
  });

  it("warns when a vault's case behavior is unknowable, naming the fail-closed posture", async () => {
    const result = await run([
      { id: "main", info: probed(true) },
      { id: "mystery", info: UNKNOWN },
    ]);
    expect(result.status).toBe("warning");
    expect(result.issues?.join("`n")).toContain("mystery");
    expect(result.issues?.join("\n")).toContain("fail-closed");
    expect(result.remediation).toContain("caseSensitive");
    // The unknowable vault's detail names the split posture, not a guess.
    expect(result.details?.vaults).toContain(
      "mystery: unknown (case-only ACL matches are settled per directory, fail-closed where one cannot be probed), probed",
    );
  });
});
