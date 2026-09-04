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
  autoSelectLocalRerankerConfigAllows,
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
    // THE-944 review round 2: doctor.ts no longer calls autoSelectLocalRerankerApplies directly —
    // that call moved into providers/registry.ts's buildRerankerDoctorProbes (extracted once G3's
    // autoSelectBlockedByPlatform distinction pushed doctor.ts over biome's 700-line file cap).
    // doctor.ts now calls buildRerankerDoctorProbes; THAT function is what must still call the
    // shared rule — so this pin follows the call to where it actually lives.
    {
      file: "src/providers/registry.ts",
      importPattern:
        /import\s*\{[^}]*autoSelectLocalRerankerApplies[^}]*\}\s*from\s*"\.\/reranker-preflight";/,
      callSubstring:
        "autoSelectLocalRerankerApplies(rerankerProvider, opts.embeddings, gatewayOpts)",
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

  // Completes the chain for doctor.ts specifically: it no longer calls
  // autoSelectLocalRerankerApplies directly (pinned above at src/providers/registry.ts), it calls
  // buildRerankerDoctorProbes, which is what calls the shared rule. Without this link, the
  // registry.ts pin alone would not prove doctor.ts is actually WIRED to it.
  it("src/cli/commands/doctor.ts imports AND calls buildRerankerDoctorProbes (the wrapper that calls the shared rule)", () => {
    const src = readSrc("src/cli/commands/doctor.ts");
    expect(src).toMatch(
      /import\s*\{[^}]*buildRerankerDoctorProbes[^}]*\}\s*from\s*"\.\.\/\.\.\/providers\/registry";/,
    );
    expect(src).toContain("...buildRerankerDoctorProbes({");
  });
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

// THE-944 review round 2 (G3): platform support is now part of the SAME shared rule — a platform
// with no onnxruntime-node native prebuild must never auto-select "local", regardless of how
// permissive the config is, because the registry would wire a reranker guaranteed to throw on its
// first real call. `autoSelectLocalRerankerConfigAllows` is the config-only half doctor still
// needs (see its own doc comment) for a platform-specific "why not" message instead of the generic
// one — its OWN table proves it stays platform-blind on purpose.
describe("autoSelectLocalRerankerApplies now folds in platform support (THE-944 review round 2, G3)", () => {
  it("false on darwin-x64 even though config alone would have said yes", () => {
    expect(
      autoSelectLocalRerankerApplies(undefined, NONE, {
        platformOverride: { platform: "darwin", arch: "x64" },
      }),
    ).toBe(false);
  });

  it("false on musl linux even though config alone would have said yes", () => {
    expect(
      autoSelectLocalRerankerApplies(undefined, NONE, {
        platformOverride: { platform: "linux", arch: "x64", isMuslRuntime: () => true },
      }),
    ).toBe(false);
  });

  it("true on a supported platform (linux glibc x64) with permissive config — unchanged from round 1", () => {
    expect(
      autoSelectLocalRerankerApplies(undefined, NONE, {
        platformOverride: { platform: "linux", arch: "x64", isMuslRuntime: () => false },
      }),
    ).toBe(true);
  });

  it("a declared block still wins over platform — false for the SAME reason as before, not a platform reason", () => {
    expect(
      autoSelectLocalRerankerApplies("local", NONE, {
        platformOverride: { platform: "darwin", arch: "x64" },
      }),
    ).toBe(false);
  });
});

describe("autoSelectLocalRerankerConfigAllows — the config-only half (THE-944 review round 2, G3)", () => {
  it("stays platform-BLIND on purpose — true on darwin-x64 with permissive config", () => {
    // Deliberately does NOT accept a platformOverride param at all: this function answers "would
    // auto-select apply from config alone", which is exactly what doctor needs to distinguish
    // "config says no" (silent) from "config says yes, platform says no" (worth a message).
    expect(autoSelectLocalRerankerConfigAllows(undefined, NONE, {})).toBe(true);
  });

  it("mirrors autoSelectLocalRerankerApplies's config-only conditions exactly", () => {
    expect(autoSelectLocalRerankerConfigAllows("local", NONE, {})).toBe(false);
    expect(autoSelectLocalRerankerConfigAllows(undefined, MODEL_TIER_FULL, {})).toBe(false);
    expect(
      autoSelectLocalRerankerConfigAllows(undefined, NONE, { gatewayBaseUrl: "http://gw" }),
    ).toBe(false);
    expect(
      autoSelectLocalRerankerConfigAllows(undefined, NONE, { gatewayUrlEnv: "http://gw" }),
    ).toBe(false);
  });
});

// Mutation evidence (G3): a version of autoSelectLocalRerankerApplies that never checked platform
// (i.e. round 1's implementation) would leave the FIRST test above green-when-it-should-be-red —
// this table is what actually pins the platform fold-in; see the fix-round report for the observed
// red/green transcript.
