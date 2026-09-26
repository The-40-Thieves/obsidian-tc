// THE-1099 (GH #964 part 2) — the boot-line surface for the read-only derived-telemetry
// exemption. Mirrors plane-opt-in-notice.test.ts's shape for a pure formatter: the underlying AND
// (`isFeedbackExemptFromReadOnly`) already has its own tests in
// packages/shared/test/config.schema.test.ts, so this file asserts only that boot-notices.ts
// reads the SAME predicate rather than restating the AND — see readOnlyFeedbackExemptionActive's
// doc comment for why a duplicate AND here would risk the boot line disagreeing with dispatch.
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import {
  formatStaleExplicitSessionNotice,
  readOnlyFeedbackExemptionActive,
} from "../src/runtime/boot-notices";

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

describe("formatStaleExplicitSessionNotice (THE-1108 fix, Codex P2)", () => {
  it("returns undefined when there is nothing stale — no line at boot", () => {
    expect(
      formatStaleExplicitSessionNotice(
        { count: 0, oldestAgeMs: null, oldestPrincipal: null },
        { maxExplicitLifetimeSeconds: 86_400, maintenanceEnabled: true },
      ),
    ).toBeUndefined();
  });

  it("maintenance ENABLED: promises the sweep will close them", () => {
    const notice = formatStaleExplicitSessionNotice(
      { count: 2, oldestAgeMs: 2 * 86_400_000, oldestPrincipal: "alice" },
      { maxExplicitLifetimeSeconds: 86_400, maintenanceEnabled: true },
    );
    expect(notice).toContain("2 open explicit session(s)");
    expect(notice).toContain("sessions.maxExplicitLifetimeSeconds");
    expect(notice).toContain("(86400s)");
    expect(notice).toContain("oldest is 2.0d old");
    expect(notice).toContain("(principal: alice)");
    expect(notice).toContain("The maintenance sweep will close them");
    expect(notice).not.toContain("maintenance.enabled is false");
  });

  it("maintenance DISABLED: does NOT promise a sweep that will never run — the bug this fixes", () => {
    const notice = formatStaleExplicitSessionNotice(
      { count: 1, oldestAgeMs: 86_400_000, oldestPrincipal: "bob" },
      { maxExplicitLifetimeSeconds: 86_400, maintenanceEnabled: false },
    );
    expect(notice).toContain("1 open explicit session(s)");
    expect(notice).not.toContain("The maintenance sweep will close them");
    expect(notice).toContain("maintenance.enabled is false");
    expect(notice).toContain("call end_session");
  });

  it("omits the principal clause when oldestPrincipal is null (a pre-principal-column row)", () => {
    const notice = formatStaleExplicitSessionNotice(
      { count: 1, oldestAgeMs: 86_400_000, oldestPrincipal: null },
      { maxExplicitLifetimeSeconds: 86_400, maintenanceEnabled: true },
    );
    expect(notice).not.toContain("principal:");
  });
});
