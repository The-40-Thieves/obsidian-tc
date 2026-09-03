// THE-944 review round 1 (F5): `autoSelectLocalRerankerApplies` (providers/reranker-preflight.ts)
// is the ONE function both `runtime/tool-wiring.ts`'s `wireGatewaySeams` (boot) and
// `cli/commands/doctor.ts` (doctor's report) call to decide whether the registry would even
// ATTEMPT to auto-select the "local" reranker. Before this file existed, the function had zero
// direct test references — a mutation replacing its gateway check with `return true` left every
// existing suite green, because `wireGatewaySeams`'s own `??` chain structurally short-circuits
// before ever observing that mistake in the one case that matters at runtime (see this file's last
// describe block for why). This is the "doctor could start lying about a gateway-configured
// deployment with nothing objecting" gap the function's own doc comment says it exists to prevent.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  autoSelectLocalRerankerApplies,
  type RerankerPreflightEmbeddings,
} from "../src/providers/reranker-preflight";

const NONE: RerankerPreflightEmbeddings = {};
const MODEL_TIER_FULL: RerankerPreflightEmbeddings = {
  modelTier: { full: { baseUrl: "http://x" } },
};

describe("autoSelectLocalRerankerApplies (THE-944 review round 1, F5)", () => {
  it("true when nothing is configured — the only case auto-select should ever fire", () => {
    expect(autoSelectLocalRerankerApplies(undefined, NONE, {})).toBe(true);
  });

  it("false when a reranker block IS declared, regardless of provider name", () => {
    expect(autoSelectLocalRerankerApplies("local", NONE, {})).toBe(false);
    expect(autoSelectLocalRerankerApplies("cohere-compatible", NONE, {})).toBe(false);
    expect(autoSelectLocalRerankerApplies("gateway", NONE, {})).toBe(false);
  });

  it("false when embeddings.modelTier.full is configured — model-tier would win first", () => {
    expect(autoSelectLocalRerankerApplies(undefined, MODEL_TIER_FULL, {})).toBe(false);
  });

  // The explicit mutation the reviewer named: "with a gateway URL configured, auto-select must be
  // false." Both sources, checked independently, and together.
  it("false when reranker.baseUrl / config.gateway.baseUrl (gatewayBaseUrl) is configured", () => {
    expect(autoSelectLocalRerankerApplies(undefined, NONE, { gatewayBaseUrl: "http://gw" })).toBe(
      false,
    );
  });

  it("false when OBSIDIAN_TC_GATEWAY_URL (gatewayUrlEnv) is configured", () => {
    expect(autoSelectLocalRerankerApplies(undefined, NONE, { gatewayUrlEnv: "http://gw" })).toBe(
      false,
    );
  });

  it("false when BOTH gateway sources are configured", () => {
    expect(
      autoSelectLocalRerankerApplies(undefined, NONE, {
        gatewayBaseUrl: "http://gw",
        gatewayUrlEnv: "http://gw-env",
      }),
    ).toBe(false);
  });

  it("an empty-string gateway URL does not count as configured (matches resolveGatewayUrl's own convention)", () => {
    expect(autoSelectLocalRerankerApplies(undefined, NONE, { gatewayBaseUrl: "" })).toBe(true);
    expect(autoSelectLocalRerankerApplies(undefined, NONE, { gatewayUrlEnv: "" })).toBe(true);
  });

  it("model-tier AND a gateway both configured -> still false (either alone is disqualifying)", () => {
    expect(
      autoSelectLocalRerankerApplies(undefined, MODEL_TIER_FULL, { gatewayBaseUrl: "http://gw" }),
    ).toBe(false);
  });
});

// "a source-scan or shared-function assertion that doctor and boot use the SAME rule so they
// cannot drift" (F5). THE-944 review round 1 made this a SHARED-FUNCTION guarantee, not merely a
// coincidence of two independent implementations: `wireGatewaySeams` now calls
// `autoSelectLocalRerankerApplies` explicitly (see tool-wiring.ts's own comment at that call site)
// instead of relying only on the `??` chain's laziness. This source-scan pins that BOTH the boot
// call site and the doctor call site actually import and invoke the same function — the style
// doctor-cli-reranker-wiring.test.ts already established for a sibling risk (a deleted line
// reverting doctor to a stale message with nothing failing).
describe("doctor and boot share the SAME auto-select rule (source-scan pin)", () => {
  function readSrc(file: string): string {
    return readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  }

  // `importPattern` tolerates either a single-line or biome-wrapped multi-line import (both are
  // real, current shapes across these two files) — it asserts the SEMANTIC fact ("this file
  // imports autoSelectLocalRerankerApplies from providers/reranker-preflight"), not one exact
  // formatting of it, so a future reformat cannot make this pin flicker for a reason that has
  // nothing to do with the property it exists to guard.
  const SITES = [
    {
      file: "src/runtime/tool-wiring.ts",
      importPattern:
        /import\s*\{[^}]*autoSelectLocalRerankerApplies[^}]*\}\s*from\s*"\.\.\/providers\/reranker-preflight";/,
      callSubstring: "autoSelectLocalRerankerApplies(undefined, embeddings, {",
    },
    {
      file: "src/cli/commands/doctor.ts",
      importPattern:
        /import\s*\{[^}]*autoSelectLocalRerankerApplies[^}]*\}\s*from\s*"\.\.\/\.\.\/providers\/reranker-preflight";/,
      callSubstring:
        "autoSelectLocalRerankerApplies(config.reranker?.provider, config.embeddings, {",
    },
  ] as const;

  for (const site of SITES) {
    it(`${site.file} imports autoSelectLocalRerankerApplies from providers/reranker-preflight`, () => {
      const src = readSrc(site.file);
      expect(src, `${site.file} must import autoSelectLocalRerankerApplies`).toMatch(
        site.importPattern,
      );
    });

    it(`${site.file} actually CALLS autoSelectLocalRerankerApplies (not just imports it)`, () => {
      const src = readSrc(site.file);
      expect(
        src,
        `${site.file} must call autoSelectLocalRerankerApplies at its documented site`,
      ).toContain(site.callSubstring);
    });
  }
});

// Documents WHY the mutation the reviewer reproduced (autoSelectLocalRerankerApplies's gateway
// check replaced with `return true`) left every runtime test green even before this fix: with a
// gateway URL configured, `gatewayReranker` is non-null, so `wireGatewaySeams`'s
// `buildModelTierReranker(embeddings) ?? gatewayReranker ?? (...)` chain short-circuits and never
// evaluates the third operand AT ALL — the mutated gate's return value is simply never observed at
// runtime in that case. This is exactly why the mutation is a DOCTOR-accuracy risk, not a runtime
// one (the review's own framing) — and exactly why the unit table above, over the pure function
// directly, is what actually pins it, not an end-to-end wireGatewaySeams assertion.
describe("why a broken gateway check inside the gate is invisible to wireGatewaySeams alone", () => {
  // `firstOperand`/`secondOperand` come back from a function (not a literal) so TypeScript cannot
  // collapse the `??` chain to "always nullish" at compile time — this is the same shape
  // wireGatewaySeams's real chain has (each operand is itself a function call's result).
  function nullableOperand<T>(value: T | null): T | null {
    return value;
  }

  it("gatewayReranker being non-null already prevents the third `??` operand from ever running", () => {
    // Structural fact about the `??` operator, asserted directly rather than re-derived: once the
    // second operand is non-null, JavaScript never evaluates the third. No amount of mutating what
    // the third operand's own gate returns can be observed through wireGatewaySeams in that state.
    const firstOperand = nullableOperand<string>(null);
    const secondOperand = nullableOperand<string>("gateway-reranker-present");
    let thirdOperandEvaluated = false;
    const result =
      firstOperand ??
      secondOperand ??
      (() => {
        thirdOperandEvaluated = true;
        return "local-reranker";
      })();
    expect(result).toBe(secondOperand);
    expect(thirdOperandEvaluated).toBe(false);
  });
});
