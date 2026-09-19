// THE-1078 — the citation stage-2 judge seam: two adapters (gateway chat, TypeSafe Jev) and the
// factory that builds whichever one config selects. citation.ts's own tests (citation.test.ts)
// already pin the END-TO-END behaviour through inferCitations; this file pins the SEAM itself in
// isolation — byte-identical chat requests, TypeSafe's threshold mapping, the egress refusal
// ordering, and the factory's config-error/no-fallback contract.
import { describe, expect, it, vi } from "vitest";
import {
  buildCitationJudge,
  chatCitationJudge,
  JUDGE_SYSTEM,
  JUDGE_SYSTEM_UNCERTAIN,
  typesafeCitationJudge,
} from "../src/experiential/citation-judge";
import { createTypesafeClient } from "../src/gateway/typesafe";
import { compileEgressFilter, EgressViolationError } from "../src/plane/egress-filter";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("chatCitationJudge — byte-identity with the pre-seam request", () => {
  it("builds the EXACT request citation.ts built inline: prompt, responseFormat, sourcePaths", async () => {
    let seen: unknown;
    const judge = vi.fn(async (req: any) => {
      seen = req;
      return { text: '{"cited": true, "score": 0.9}', model: "fake" };
    });
    const adapter = chatCitationJudge(judge);
    const outcome = await adapter({
      source: "SOURCE TEXT",
      response: "RESPONSE TEXT",
      sourcePaths: ["notes/a.md"],
    });
    expect(seen).toEqual({
      messages: [
        { role: "system", content: JUDGE_SYSTEM },
        { role: "user", content: "SOURCE:\nSOURCE TEXT\n\nRESPONSE:\nRESPONSE TEXT" },
      ],
      responseFormat: { type: "json_object" },
      sourcePaths: ["notes/a.md"],
    });
    expect(outcome).toEqual({ kind: "ok", verdict: { cited: true, score: 0.9 } });
  });

  it("slices source to 1500 chars and response to 4000, exactly as before", async () => {
    let seen = "";
    const judge = vi.fn(async (req: any) => {
      seen = req.messages[1].content;
      return { text: '{"cited": false, "score": 0}', model: "fake" };
    });
    const adapter = chatCitationJudge(judge);
    await adapter({ source: "s".repeat(2000), response: "r".repeat(5000), sourcePaths: [] });
    const sourcePart = seen.slice("SOURCE:\n".length, seen.indexOf("\n\nRESPONSE:"));
    const responsePart = seen.slice(seen.indexOf("RESPONSE:\n") + "RESPONSE:\n".length);
    expect(sourcePart.length).toBe(1500);
    expect(responsePart.length).toBe(4000);
  });

  it("allowUncertain OFF: prompt is JUDGE_SYSTEM, and uncertain is unparseable", async () => {
    const adapter = chatCitationJudge(async () => ({
      text: '{"cited": "uncertain", "score": 0.5}',
      model: "fake",
    }));
    const outcome = await adapter({ source: "s", response: "r", sourcePaths: [] });
    expect(outcome).toEqual({ kind: "unparseable" });
  });

  it("allowUncertain ON: prompt is JUDGE_SYSTEM_UNCERTAIN, and uncertain parses", async () => {
    let seenSystem = "";
    const adapter = chatCitationJudge(
      async (req: any) => {
        seenSystem = req.messages[0].content;
        return { text: '{"cited": "uncertain", "score": 0.5}', model: "fake" };
      },
      { allowUncertain: true },
    );
    const outcome = await adapter({ source: "s", response: "r", sourcePaths: [] });
    expect(seenSystem).toBe(JUDGE_SYSTEM_UNCERTAIN);
    expect(outcome).toEqual({ kind: "ok", verdict: { cited: "uncertain", score: 0.5 } });
  });

  it("a judge that throws is reported as transport, unless it's an EgressViolationError", async () => {
    const transport = chatCitationJudge(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(transport({ source: "s", response: "r", sourcePaths: [] })).resolves.toEqual({
      kind: "transport",
    });

    const egress = chatCitationJudge(async () => {
      throw new EgressViolationError("guard fired");
    });
    await expect(egress({ source: "s", response: "r", sourcePaths: [] })).rejects.toBeInstanceOf(
      EgressViolationError,
    );
  });
});

describe("typesafeCitationJudge — threshold mapping", () => {
  function judgeOf(noul: number, threshold: number) {
    const fetchFn = (async () =>
      jsonResponse({
        model: "jev-1.13.0",
        answers: { q: { type: "noul", noul } },
      })) as unknown as typeof fetch;
    const client = createTypesafeClient({ baseUrl: "http://ts", apiKey: "k", fetchFn });
    return typesafeCitationJudge(client, {
      model: "jev-1.13.0",
      threshold,
      filter: compileEgressFilter([]),
    });
  }

  it("noul 0.89 with threshold 0.9 -> cited false, score 0.89", async () => {
    const adapter = judgeOf(0.89, 0.9);
    const outcome = await adapter({ source: "s", response: "r", sourcePaths: [] });
    expect(outcome).toEqual({ kind: "ok", verdict: { cited: false, score: 0.89 } });
  });

  it("noul 0.9 with threshold 0.9 -> cited true (>= is inclusive)", async () => {
    const adapter = judgeOf(0.9, 0.9);
    const outcome = await adapter({ source: "s", response: "r", sourcePaths: [] });
    expect(outcome).toEqual({ kind: "ok", verdict: { cited: true, score: 0.9 } });
  });

  it("never produces 'uncertain' — Noul has no third answer", async () => {
    const adapter = judgeOf(0.5, 0.9);
    const outcome = await adapter({ source: "s", response: "r", sourcePaths: [] });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") expect(outcome.verdict.cited).not.toBe("uncertain");
  });

  it("a transport failure (non-EgressViolationError) reports {kind: transport}", async () => {
    const fetchFn = (async () => jsonResponse({}, 401)) as unknown as typeof fetch;
    const client = createTypesafeClient({
      baseUrl: "http://ts",
      apiKey: "k",
      fetchFn,
      maxAttempts: 1,
    });
    const adapter = typesafeCitationJudge(client, {
      model: "m",
      threshold: 0.5,
      filter: compileEgressFilter([]),
    });
    await expect(adapter({ source: "s", response: "r", sourcePaths: [] })).resolves.toEqual({
      kind: "transport",
    });
  });
});

// A 2xx TypeSafe body that does not carry a well-formed single Noul answer means the judge
// ANSWERED, unusably — the same fault class as the chat adapter's unparseable JSON reply, and it
// must be classified `{kind: "unparseable"}` here (folded into `parseFailures` upstream in
// citation.ts), never `{kind: "transport"}` (which citation.ts folds into `judgeErrors`).
// Conflating the two was the exact defect THE-717 fixed for the chat judge; this pins the same
// distinction for TypeSafe. "No persistence": citation.ts's stage-2 loop only stamps a chunk_id
// from `verdicts.get(...)`, and an `unparseable` outcome never populates that map — so a
// malformed response results in no citation row being written, verified at the seam here.
describe("typesafeCitationJudge — a malformed 2xx is unparseable, not transport", () => {
  function adapterFor(body: unknown) {
    const fetchFn = (async () => jsonResponse(body)) as unknown as typeof fetch;
    const client = createTypesafeClient({ baseUrl: "http://ts", apiKey: "k", fetchFn });
    return typesafeCitationJudge(client, {
      model: "m",
      threshold: 0.5,
      filter: compileEgressFilter([]),
    });
  }
  const outcomeOf = (adapter: ReturnType<typeof adapterFor>) =>
    adapter({ source: "s", response: "r", sourcePaths: [] });

  it("noul 7 (out of [0, 1]) -> unparseable, never persisted as cited=true", async () => {
    await expect(
      outcomeOf(adapterFor({ model: "m", answers: { q: { type: "noul", noul: 7 } } })),
    ).resolves.toEqual({ kind: "unparseable" });
  });

  it("noul -0.1 (out of [0, 1]) -> unparseable", async () => {
    await expect(
      outcomeOf(adapterFor({ model: "m", answers: { q: { type: "noul", noul: -0.1 } } })),
    ).resolves.toEqual({ kind: "unparseable" });
  });

  it("two answers -> unparseable (never 'take the first key')", async () => {
    await expect(
      outcomeOf(
        adapterFor({
          model: "m",
          answers: { q1: { type: "noul", noul: 0.9 }, q2: { type: "noul", noul: 0.1 } },
        }),
      ),
    ).resolves.toEqual({ kind: "unparseable" });
  });

  it("zero answers -> unparseable", async () => {
    await expect(outcomeOf(adapterFor({ model: "m", answers: {} }))).resolves.toEqual({
      kind: "unparseable",
    });
  });

  it('wrong answer "type" -> unparseable', async () => {
    await expect(
      outcomeOf(adapterFor({ model: "m", answers: { q: { type: "boolean", noul: 0.5 } } })),
    ).resolves.toEqual({ kind: "unparseable" });
  });
});

// THE-934: egress refusal must happen BEFORE any request is built — this test FAILS if the
// `assertSourcePathsAllowed` call in typesafeCitationJudge is removed, because the fetch mock
// would then be invoked and `fetchCalled` would flip true.
describe("typesafeCitationJudge — egress refusal precedes any fetch", () => {
  it("throws EgressViolationError for an excluded sourcePath, and NEVER calls fetch", async () => {
    let fetchCalled = false;
    const fetchFn = (async () => {
      fetchCalled = true;
      return jsonResponse({ model: "m", answers: { q: { type: "noul", noul: 1 } } });
    }) as unknown as typeof fetch;
    const client = createTypesafeClient({ baseUrl: "http://ts", apiKey: "k", fetchFn });
    const adapter = typesafeCitationJudge(client, {
      model: "m",
      threshold: 0.5,
      filter: compileEgressFilter(["Private"]),
    });
    await expect(
      adapter({ source: "s", response: "r", sourcePaths: ["Private/note.md"] }),
    ).rejects.toBeInstanceOf(EgressViolationError);
    expect(fetchCalled).toBe(false);
  });
});

describe("buildCitationJudge — factory", () => {
  const filter = compileEgressFilter([]);

  it("provider absent (or 'gateway') with a gateway configured builds the chat adapter", async () => {
    const gatewayJudge = vi.fn(async () => ({ text: '{"cited": true, "score": 1}', model: "g" }));
    const judge = buildCitationJudge(undefined, { gatewayJudge, excludeFilter: filter });
    expect(judge).not.toBeNull();
    const outcome = await judge?.({ source: "s", response: "r", sourcePaths: [] });
    expect(outcome).toEqual({ kind: "ok", verdict: { cited: true, score: 1 } });
    expect(gatewayJudge).toHaveBeenCalledTimes(1);
  });

  it("provider 'gateway' with no gateway configured is null (stage-1-only mode, unchanged)", () => {
    const judge = buildCitationJudge(
      { provider: "gateway" },
      { gatewayJudge: null, excludeFilter: filter },
    );
    expect(judge).toBeNull();
  });

  it('provider "typesafe" with no model throws at construction', () => {
    expect(() =>
      buildCitationJudge(
        { provider: "typesafe", threshold: 0.9, apiKey: "k" },
        { excludeFilter: filter },
      ),
    ).toThrow(/model/i);
  });

  it('provider "typesafe" with no threshold throws at construction', () => {
    expect(() =>
      buildCitationJudge(
        { provider: "typesafe", model: "jev-1.13.0", apiKey: "k" },
        { excludeFilter: filter },
      ),
    ).toThrow(/threshold/i);
  });

  it('provider "typesafe" with no resolvable key throws naming apiKeyEnv — no fallback to gateway', () => {
    const prev = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
      const gatewayJudge = vi.fn();
      expect(() =>
        buildCitationJudge(
          { provider: "typesafe", model: "jev-1.13.0", threshold: 0.9 },
          { gatewayJudge, excludeFilter: filter },
        ),
      ).toThrow(/TYPESAFE_API_KEY/);
      expect(gatewayJudge).not.toHaveBeenCalled();
    } finally {
      if (prev !== undefined) process.env.TYPESAFE_API_KEY = prev;
    }
  });

  it('provider "typesafe" with a custom apiKeyEnv names THAT variable in the error, not the default', () => {
    const prev = process.env.MY_TS_KEY;
    delete process.env.MY_TS_KEY;
    try {
      expect(() =>
        buildCitationJudge(
          { provider: "typesafe", model: "jev-1.13.0", threshold: 0.9, apiKeyEnv: "MY_TS_KEY" },
          { excludeFilter: filter },
        ),
      ).toThrow(/MY_TS_KEY/);
    } finally {
      if (prev !== undefined) process.env.MY_TS_KEY = prev;
    }
  });

  it('provider "typesafe" fully configured builds a working adapter (inline apiKey, no env)', async () => {
    const fetchFn = (async () =>
      jsonResponse({
        model: "jev-1.13.0",
        answers: { q: { type: "noul", noul: 0.95 } },
      })) as unknown as typeof fetch;
    const judge = buildCitationJudge(
      { provider: "typesafe", model: "jev-1.13.0", threshold: 0.9, apiKey: "inline-key" },
      { excludeFilter: filter, fetchFn },
    );
    expect(judge).not.toBeNull();
    const outcome = await judge?.({ source: "s", response: "r", sourcePaths: [] });
    expect(outcome).toEqual({ kind: "ok", verdict: { cited: true, score: 0.95 } });
  });
});
