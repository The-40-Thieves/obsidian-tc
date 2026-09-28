// PR B of GH #995's two-part follow-up: doctor's `setupOrigin` notice — pure formatter, see
// cli/commands/doctor.ts's own comment on why it's separated from the structured report.
import { describe, expect, it } from "vitest";
import { formatSetupOriginNotice } from "../src/cli/commands/doctor";

describe("formatSetupOriginNotice", () => {
  it("is undefined for an absent setupOrigin (the normal, interactively-configured case)", () => {
    expect(formatSetupOriginNotice(undefined)).toBeUndefined();
  });

  it("is undefined for any value other than 'first-run-fallback'", () => {
    expect(formatSetupOriginNotice("something-else")).toBeUndefined();
  });

  it("names the fallback and points at `obsidian-tc setup` for 'first-run-fallback'", () => {
    const text = formatSetupOriginNotice("first-run-fallback");
    expect(text).toContain("first-run fallback");
    expect(text).toContain("obsidian-tc setup");
  });
});
