// THE-807 standing gate: every eval flag that reaches the `--json` artifact must be classified as
// either dependency-gated (and therefore preflighted), guarded inline, or dependency-free.
//
// The bug this closes is not any one flag — it is that `run.ts` stamps the artifact from the flags
// the caller PASSED rather than from what the run DID, so a flag whose backend is absent silently
// scores the control against itself and records the arm as run. Three flags had that shape at once,
// and the convention that would have caught them was already written twice in the same file. A
// convention that has failed three times unaided needs a gate, not a fourth comment.
//
// This gate is deliberately a CLOSED SET over the artifact flag list: a new flag fails the test
// until someone classifies it, which forces the "can this no-op in silence?" question at the point
// the flag is added rather than at the point a null result is misread months later.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertFlagDependencies,
  DEPENDENCY_GATED_FLAGS,
  type FlagLivenessContext,
  GUARDED_ELSEWHERE_FLAGS,
  InertEvalFlagError,
  NO_EXTERNAL_DEPENDENCY_FLAGS,
} from "../eval/flag-liveness";

const RUN_TS = join(dirname(fileURLToPath(import.meta.url)), "..", "eval", "run.ts");

/**
 * Pull every token the `--json` artifact flag list can emit.
 *
 * Scanned from source rather than imported because the array is built inline inside `main()` from
 * local `const`s — there is no value to import. That makes the extraction itself a thing that can
 * silently break (a renamed variable, a moved block), so it is floored below: an extraction that
 * finds nothing must fail loudly, exactly like the flags it guards. A gate that scans zero files
 * reports success.
 */
function artifactFlagTokens(): string[] {
  const src = readFileSync(RUN_TS, "utf8");
  const blockStart = src.indexOf("if (jsonPath) {");
  if (blockStart < 0) throw new Error("could not locate the `if (jsonPath)` artifact block");
  const arrayStart = src.indexOf("const flags = [", blockStart);
  if (arrayStart < 0) throw new Error("could not locate the artifact `const flags = [`");
  const arrayEnd = src.indexOf("].filter(", arrayStart);
  if (arrayEnd < 0) throw new Error("could not locate the end of the artifact flag array");
  const block = src.slice(arrayStart, arrayEnd);

  const tokens = new Set<string>();
  // Plain entries: `adaptive && "adaptive-rrf"`.
  for (const m of block.matchAll(/"([a-z0-9-]+)"/g)) if (m[1]) tokens.add(m[1]);
  // Parameterised entries contribute their prefix: `` `decompose@${...}` ``.
  for (const m of block.matchAll(/`([a-z0-9-]+)@\$\{/g)) if (m[1]) tokens.add(m[1]);
  return [...tokens];
}

/** Every flag the run can stamp must fall in exactly one bucket. */
function classify(token: string): string[] {
  const buckets: string[] = [];
  if (token in DEPENDENCY_GATED_FLAGS) buckets.push("DEPENDENCY_GATED_FLAGS");
  if (GUARDED_ELSEWHERE_FLAGS.has(token)) buckets.push("GUARDED_ELSEWHERE_FLAGS");
  if (NO_EXTERNAL_DEPENDENCY_FLAGS.has(token)) buckets.push("NO_EXTERNAL_DEPENDENCY_FLAGS");
  return buckets;
}

describe("eval artifact flags are classified for liveness (THE-807)", () => {
  // FLOOR. Everything below is a claim about a set parsed out of a source file; if the parse breaks
  // the set goes empty and every other assertion in this file passes vacuously. These two run first
  // and fail loudly instead.
  it("extracts a non-empty flag list from run.ts", () => {
    const tokens = artifactFlagTokens();
    expect(tokens.length).toBeGreaterThanOrEqual(15);
  });

  it("extracts the three flags that motivated the gate", () => {
    const tokens = artifactFlagTokens();
    expect(tokens).toEqual(expect.arrayContaining(["sparse", "gated-rerank", "decompose"]));
  });

  it("classifies every artifact flag in exactly one bucket", () => {
    const unclassified: string[] = [];
    const doubleClassified: string[] = [];
    for (const token of artifactFlagTokens()) {
      const buckets = classify(token);
      if (buckets.length === 0) unclassified.push(token);
      if (buckets.length > 1) doubleClassified.push(`${token} -> ${buckets.join(", ")}`);
    }
    expect(
      unclassified,
      "A new eval flag reaches the --json artifact but is not classified in eval/flag-liveness.ts. " +
        "Decide which it is: DEPENDENCY_GATED_FLAGS (needs something outside this process — add a " +
        "liveness check), GUARDED_ELSEWHERE_FLAGS (already refuses inline), or " +
        "NO_EXTERNAL_DEPENDENCY_FLAGS (a pure in-process path). An unclassified flag can stamp the " +
        "artifact while doing nothing.",
    ).toEqual([]);
    expect(doubleClassified, "a flag must sit in exactly one bucket").toEqual([]);
  });

  // EXISTENCE FLOOR for the wiring, not the module. Everything else here proves
  // `assertFlagDependencies` behaves correctly; none of it proves `run.ts` still CALLS it. Deleting
  // the preflight would leave every other assertion in this file green while restoring the exact
  // bug. Registered is not emitting.
  it("run.ts actually calls the preflight, and gates every dependency-gated flag on it", () => {
    const src = readFileSync(RUN_TS, "utf8");
    expect(src, "run.ts no longer calls assertFlagDependencies — the preflight is inert").toContain(
      "await assertFlagDependencies(",
    );
    // Each gated flag must be passed into the preflight, not merely exist in the registry.
    const callStart = src.indexOf("await assertFlagDependencies(");
    const callBlock = src.slice(callStart, src.indexOf("const report = await runEval(", callStart));
    for (const token of Object.keys(DEPENDENCY_GATED_FLAGS)) {
      expect(
        callBlock,
        `${token} is dependency-gated but run.ts never passes it to the preflight`,
      ).toContain(`"${token}"`);
    }
  });

  it("does not classify flags that no longer exist", () => {
    const tokens = new Set(artifactFlagTokens());
    const stale = [
      ...Object.keys(DEPENDENCY_GATED_FLAGS),
      ...GUARDED_ELSEWHERE_FLAGS,
      ...NO_EXTERNAL_DEPENDENCY_FLAGS,
    ].filter((t) => !tokens.has(t));
    expect(stale, "classified but absent from the artifact flag list — delete the entry").toEqual(
      [],
    );
  });
});

/** Await a refusal and hand back the typed error. Resolving is itself a failure — `.catch()` alone
 *  widens to `void | Error` and, worse, would let a run that DID NOT refuse fall through to
 *  assertions on `undefined`. */
async function captureRefusal(
  keys: readonly string[],
  ctx: FlagLivenessContext,
): Promise<InertEvalFlagError> {
  try {
    await assertFlagDependencies(keys, ctx);
  } catch (e) {
    if (e instanceof InertEvalFlagError) return e;
    throw e;
  }
  throw new Error(`expected a refusal for [${keys.join(", ")}], but the preflight resolved`);
}

describe("dependency-gated flags refuse when their backend is absent (THE-807)", () => {
  const deadFetch: typeof fetch = () => Promise.reject(new Error("connect ECONNREFUSED"));
  const liveFetch: typeof fetch = () => Promise.resolve(new Response("{}", { status: 200 }));

  const absent = {
    provider: {},
    reranker: null,
    decomposeUrl: "http://127.0.0.1:11434",
    fetchFn: deadFetch,
  };
  const present = {
    provider: { embedFull: () => Promise.resolve([]) },
    reranker: () => Promise.resolve([]),
    decomposeUrl: "http://127.0.0.1:11434",
    fetchFn: liveFetch,
  };

  it("refuses all three when every backend is missing", async () => {
    await expect(
      assertFlagDependencies(["sparse", "gated-rerank", "decompose"], absent),
    ).rejects.toBeInstanceOf(InertEvalFlagError);
  });

  it("names the specific backend rather than failing generically", async () => {
    // The acceptance criterion is that the refusal is actionable: an operator must learn WHICH
    // dependency is missing. A generic "not configured" is what let this class hide.
    const err = await captureRefusal(["sparse", "gated-rerank", "decompose"], absent);
    expect(err.failures).toHaveLength(3);
    expect(err.message).toContain("SPARSE_URL");
    expect(err.message).toContain("RERANK_URL");
    expect(err.message).toContain("DECOMPOSE_URL");
    expect(err.message).toContain("http://127.0.0.1:11434");
  });

  it("reports EVERY missing backend in one run, not just the first", async () => {
    const err = await captureRefusal(["sparse", "gated-rerank", "decompose"], absent);
    expect(err.failures.map((f) => f.split(":")[0])).toEqual([
      "--sparse",
      "--gated-rerank",
      "--decompose",
    ]);
  });

  it("passes when every backend is present", async () => {
    await expect(
      assertFlagDependencies(["sparse", "gated-rerank", "decompose"], present),
    ).resolves.toBeUndefined();
  });

  it("ignores flags that are not dependency-gated", async () => {
    await expect(assertFlagDependencies(["mmr", "temporal"], absent)).resolves.toBeUndefined();
  });

  it("checks nothing when no gated flag was requested", async () => {
    await expect(assertFlagDependencies([], absent)).resolves.toBeUndefined();
  });

  // Per-flag, so a regression names the flag it broke rather than "one of three".
  it("--sparse keys on embedFull being callable, which is the branch run.ts takes", async () => {
    await expect(assertFlagDependencies(["sparse"], absent)).rejects.toThrow(/embedFull/);
    await expect(assertFlagDependencies(["sparse"], present)).resolves.toBeUndefined();
    // A provider carrying a non-callable `embedFull` must not read as live.
    await expect(
      assertFlagDependencies(["sparse"], { ...present, provider: { embedFull: true } }),
    ).rejects.toThrow(/embedFull/);
  });

  it("--gated-rerank keys on a non-null reranker", async () => {
    await expect(assertFlagDependencies(["gated-rerank"], absent)).rejects.toThrow(
      /not_configured/,
    );
    await expect(
      assertFlagDependencies(["gated-rerank"], { ...present, reranker: undefined }),
    ).rejects.toThrow(/RERANK_URL/);
  });

  it("--decompose treats a non-2xx probe as dead, not just a thrown fetch", async () => {
    const notFound: typeof fetch = () => Promise.resolve(new Response("", { status: 404 }));
    await expect(
      assertFlagDependencies(["decompose"], { ...present, fetchFn: notFound }),
    ).rejects.toThrow(/HTTP 404/);
  });
});
