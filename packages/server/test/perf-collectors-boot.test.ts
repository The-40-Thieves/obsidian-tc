import { describe, expect, it } from "vitest";

import { collectBoot } from "../eval/perf/collectors/boot";

// The real probe runs in a fresh subprocess and costs a cold boot (~600ms), so these drive the
// injected spawn seam instead — the same seam sample.ts uses for isolated runs. What is worth
// pinning here is the PARSING and the REFUSAL logic: a boot probe that silently measured nothing
// would report excellent timings, which is the exact failure this family exists to make impossible.
const probe = (o: Partial<Record<string, number>> = {}): (() => string) => {
  const body = {
    module_eval_ms: 600,
    registration_ms: 38,
    tools_list_ms: 0.3,
    tools_registered: 148,
    ...o,
  };
  return () => `${JSON.stringify(body)}\n`;
};

describe("boot collector (THE-515, family 16)", () => {
  it("emits the four boot metrics with the right classes", () => {
    const byKey = Object.fromEntries(collectBoot(probe()).map((s) => [s.key, s]));

    expect(byKey["boot.tools_registered"]?.value).toBe(148);
    expect(byKey["boot.module_eval_ms"]?.value).toBe(600);
    expect(byKey["boot.registration_ms"]?.value).toBe(38);
    expect(byKey["boot.tools_list_ms"]?.value).toBe(0.3);

    // The count is the only deterministic figure, so it is the only hard one. Everything else is
    // wall time on a shared runner and is warn-class, per the README's Determinism section.
    expect(byKey["boot.tools_registered"]?.class).toBe("hard");
    expect(byKey["boot.tools_registered"]?.direction).toBe("exact");
    for (const k of ["boot.module_eval_ms", "boot.registration_ms", "boot.tools_list_ms"])
      expect(byKey[k]?.class).toBe("warn");
  });

  it("refuses a probe that registered nothing", () => {
    expect(() => collectBoot(probe({ tools_registered: 0 }))).toThrow(/tools_registered/);
  });

  it("refuses a non-positive duration", () => {
    expect(() => collectBoot(probe({ module_eval_ms: 0 }))).toThrow(/module_eval_ms/);
    expect(() => collectBoot(probe({ registration_ms: -1 }))).toThrow(/registration_ms/);
  });

  // Cross-vendor review (codex) flagged that `> 0` coerces, so a numeric STRING or a null would
  // have sailed through into the report and corrupted an aggregate instead of failing.
  it("rejects coercible and non-finite values rather than emitting them", () => {
    for (const bad of ["600", null, Number.NaN, Number.POSITIVE_INFINITY, undefined])
      expect(() => collectBoot(probe({ module_eval_ms: bad as never }))).toThrow(
        /not a finite number/,
      );
    expect(() => collectBoot(probe({ tools_list_ms: "0.3" as never }))).toThrow(
      /not a finite number/,
    );
    expect(() => collectBoot(probe({ tools_registered: 148.5 }))).toThrow(/not an integer/);
  });

  it("allows tools_list_ms to be 0 — it can legitimately round to zero on a fast host", () => {
    const byKey = Object.fromEntries(
      collectBoot(probe({ tools_list_ms: 0 })).map((s) => [s.key, s]),
    );
    expect(byKey["boot.tools_list_ms"]?.value).toBe(0);
  });

  it("rejects a JSON scalar or array, not just malformed text", () => {
    expect(() => collectBoot(() => "42\n")).toThrow(/not an object/);
    expect(() => collectBoot(() => "null\n")).toThrow(/not an object/);
  });

  it("reads the LAST line, so stray stdout cannot corrupt the parse", () => {
    const noisy = (): string =>
      `some dependency warning\n${JSON.stringify({
        module_eval_ms: 1,
        registration_ms: 1,
        tools_list_ms: 1,
        tools_registered: 148,
      })}\n`;
    expect(collectBoot(noisy).find((s) => s.key === "boot.tools_registered")?.value).toBe(148);
  });

  it("fails loudly on empty or non-JSON output rather than reporting zeros", () => {
    expect(() => collectBoot(() => "   \n")).toThrow(/no output/);
    expect(() => collectBoot(() => "not json at all\n")).toThrow(/not JSON/);
  });
});
