// THE-1099 (GH #964 part 2) — the boot-line surface for the read-only derived-telemetry
// exemption. Mirrors plane-opt-in-notice.test.ts's shape for a pure formatter: the underlying AND
// (`isFeedbackExemptFromReadOnly`) already has its own tests in
// packages/shared/test/config.schema.test.ts, so this file asserts only that boot-notices.ts
// reads the SAME predicate rather than restating the AND — see readOnlyFeedbackExemptionActive's
// doc comment for why a duplicate AND here would risk the boot line disagreeing with dispatch.
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { readOnlyFeedbackExemptionActive } from "../src/runtime/boot-notices";

function configWith(experiential: Record<string, unknown>) {
  return ServerConfigSchema.parse({
    vaults: [{ id: "main", path: "/v" }],
    experiential,
  });
}

describe("readOnlyFeedbackExemptionActive (THE-1099)", () => {
  it("false on a minimal config — nothing changes for an existing config", () => {
    expect(readOnlyFeedbackExemptionActive(configWith({}))).toBe(false);
  });

  it("true only when BOTH allowFeedbackInReadOnly and logRetrievals are true", () => {
    expect(
      readOnlyFeedbackExemptionActive(
        configWith({ allowFeedbackInReadOnly: true, logRetrievals: true }),
      ),
    ).toBe(true);
  });

  it("false when allowFeedbackInReadOnly is on but logRetrievals is off — the reporter's own second config", () => {
    expect(
      readOnlyFeedbackExemptionActive(
        configWith({ allowFeedbackInReadOnly: true, logRetrievals: false }),
      ),
    ).toBe(false);
  });

  it("false when logRetrievals is on but allowFeedbackInReadOnly is off (today's default)", () => {
    expect(
      readOnlyFeedbackExemptionActive(
        configWith({ allowFeedbackInReadOnly: false, logRetrievals: true }),
      ),
    ).toBe(false);
  });
});
