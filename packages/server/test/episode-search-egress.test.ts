// THE-934 fix round 3 (C) — episode-search.ts's semantic channel is a REGRESSION this PR
// introduced: `provider.embed(..., { input: "document" })` never declared `sourcePaths`, and
// round 1 wired createEmbeddingProvider's port guard to throw unconditionally on an undeclared
// sourcePaths (not merely when a path is actually excluded). semanticRankEpisodes swallows every
// error into `[]` (a provider outage should degrade hybrid search to lexical-only, not fail the
// whole call) — so the guard firing looks identical to "the provider is down", and work_search's
// semantic arm went silently empty on EVERY install, whether or not egress.excludePaths is even
// configured. Every existing test used a hand-rolled EmbeddingProvider fake (m8-experiential-
// tools.test.ts's stubProvider), never the real factory, so nothing caught it. This file builds
// the provider through the REAL createEmbeddingProvider (a fake fetchFn transport underneath, the
// same shape egress-port-guard.test.ts uses) to prove semanticRankEpisodes actually reaches it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { EmbeddingProvider } from "../src/embeddings";
import { createEmbeddingProvider } from "../src/embeddings";
import type { FetchFn } from "../src/embeddings/http";
import { semanticRankEpisodes } from "../src/experiential/episode-search";
import { EgressViolationError } from "../src/plane/egress-filter";

const CFG = { provider: "ollama", model: "nomic-embed-text", dimensions: 2 } as const;

/** Returns one `vector` per requested text (read off the ollama-shaped `{ input: string[] }`
 *  request body) — the real query-encoder requests exactly 1 text for `dense()` and
 *  episode-search requests N for the batched document call; a fixed-length mock response would
 *  fail `assertVectors`' length check on whichever call didn't match. */
function embedFetch(vector: number[]): { fetchFn: FetchFn; state: { calls: number } } {
  const state = { calls: 0 };
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    state.calls += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
    const n = body.input?.length ?? 1;
    return new Response(JSON.stringify({ embeddings: Array.from({ length: n }, () => vector) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as FetchFn;
  return { fetchFn, state };
}

describe("episode-search semantic channel through the REAL embedding port (THE-934 fix round 3, C)", () => {
  it("finds a semantic hit through createEmbeddingProvider — the regression: this used to always return []", async () => {
    const { fetchFn, state } = embedFetch([1, 0]);
    // No excludeFilter passed at all -- egress.excludePaths unconfigured is the DEFAULT install
    // shape, and the port guard still fires unconditionally on an undeclared sourcePaths
    // regardless of whether any filter is configured (assertSourcePathsAllowed throws on
    // `undefined` before it ever looks at the filter's patterns).
    const provider = createEmbeddingProvider(CFG, { fetchFn });
    const ids = await semanticRankEpisodes(provider, "query text", [
      { id: "e1", summary: "a matching summary" },
      { id: "e2", summary: null },
    ]);
    expect(ids).toEqual(["e1"]);
    expect(state.calls).toBeGreaterThan(0);
  });

  // THE-934 fix round 4 (6): the DECLARATION itself, not merely "the call went through". `[]` is a
  // load-bearing claim -- "this request carries no vault content" -- and the port trusts it, so a
  // regression that swapped it for `undefined` (throws) or for a fabricated path (passes the guard
  // while lying about provenance) must be visible here. The wrapper sits OUTSIDE the real port, so
  // the guard is still the thing that ran underneath.
  it("declares sourcePaths: [] on the document call — the exact claim the port is trusting", async () => {
    const { fetchFn } = embedFetch([1, 0]);
    const real = createEmbeddingProvider(CFG, { fetchFn });
    const seen: Array<{ input?: string; sourcePaths?: string[] }> = [];
    const observed: EmbeddingProvider = {
      ...real,
      embed: (texts, o) => {
        seen.push({ input: o?.input, sourcePaths: o?.sourcePaths });
        return real.embed(texts, o);
      },
    };
    await semanticRankEpisodes(observed, "query text", [{ id: "e1", summary: "a summary" }]);
    const doc = seen.find((c) => c.input === "document");
    expect(doc, "no document embed call reached the provider at all").toBeDefined();
    expect(doc?.sourcePaths).toEqual([]);
  });

  // THE-934 fix round 3 (B)'s rule, pinned for this module in fix round 4 (6): this function
  // swallows EVERY error into `[]` by design (a provider outage degrades hybrid search to
  // lexical-only). A guard refusal is not an outage -- it means the `[]` declaration above is
  // wrong -- so it must propagate. Without this test the two are indistinguishable from outside,
  // which is exactly how the round-3 regression stayed invisible on every install.
  it("an EgressViolationError from the port PROPAGATES; an ordinary provider error still degrades to []", async () => {
    const { fetchFn } = embedFetch([1, 0]);
    const real = createEmbeddingProvider(CFG, { fetchFn });
    const throwing = (e: Error): EmbeddingProvider => ({
      ...real,
      embed: async (texts, o) => {
        if (o?.input === "document") throw e;
        return real.embed(texts, o);
      },
    });
    await expect(
      semanticRankEpisodes(throwing(new EgressViolationError("guard fired")), "q", [
        { id: "e1", summary: "a summary" },
      ]),
    ).rejects.toBeInstanceOf(EgressViolationError);
    await expect(
      semanticRankEpisodes(throwing(new Error("provider unreachable")), "q", [
        { id: "e1", summary: "a summary" },
      ]),
    ).resolves.toEqual([]);
  });
});

// THE-934 fix round 3 (C) rested on a claim about the COLUMN: `agent_episodes.summary` carries a
// tool name, a caller id, enums, integer counts and poison tags, so it cannot quote note content
// and cannot carry a vault path -- which is what makes `sourcePaths: []` a true declaration rather
// than an empty one hiding vault text. summarize-episode.test.ts pins the SHAPE (a toEqual on the
// exact key set, so a new FIELD cannot appear silently). Round 3's own review (NB3) noted the
// other half was unpinned: nothing stopped a future SECOND WRITER of the column -- the deferred
// Tier-1 LLM reflection layer, say -- from putting note text there while every test stayed green.
// This is that pin (fix round 4, 6): the writer set is an inventory, in the same shape as
// egress-port-inventory.test.ts's factory allowlists.
const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));

function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) listTsFiles(abs, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(abs);
  }
  return out;
}

/** Files whose SQL writes the agent_episodes row at all — an INSERT of the row, or an UPDATE that
 *  assigns `summary`. Deliberately coarse: over-matching costs a deliberate allowlist entry,
 *  under-matching would let a new writer through, which is the failure this exists to prevent. */
function agentEpisodeWriters(): string[] {
  const hits: string[] = [];
  for (const abs of listTsFiles(SRC_ROOT)) {
    const text = readFileSync(abs, "utf8");
    const insert = /INSERT\s+INTO\s+agent_episodes/i.test(text);
    const update = /UPDATE\s+agent_episodes[\s\S]{0,400}?\bsummary\s*=/i.test(text);
    if (insert || update) hits.push(relative(SRC_ROOT, abs).replace(/\\/g, "/"));
  }
  return hits.sort();
}

describe("agent_episodes.summary has ONE content-bearing writer (THE-934 fix round 4, 6)", () => {
  it("finds a non-trivial number of source files — a broken scan is not a clean sweep", () => {
    expect(listTsFiles(SRC_ROOT).length).toBeGreaterThan(300);
  });

  it("only the four audited modules write an agent_episodes row at all", () => {
    // experiential/episodes.ts     — the capture INSERT. Its column list does NOT include
    //                                `summary`, so a captured episode starts with it NULL.
    // experiential/reflect.ts      — the ONLY writer of a non-NULL summary, and it binds
    //                                serializeEpisodeSummary (asserted below).
    // experiential/context-bundle.ts — the import path: copies another install's already-built
    //                                Tier-0 summary verbatim, and separately NULLs it on forget.
    // experiential/forget.ts       — NULLs the column; never writes content into it.
    expect(agentEpisodeWriters()).toEqual([
      "experiential/context-bundle.ts",
      "experiential/episodes.ts",
      "experiential/forget.ts",
      "experiential/reflect.ts",
    ]);
  });

  it("reflect.ts's two summary UPDATE statements are BOUND to serializeEpisodeSummary — no second value can reach the column", () => {
    const src = readFileSync(join(SRC_ROOT, "experiential/reflect.ts"), "utf8");
    expect(src).toMatch(/const summaryFor[\s\S]{0,160}serializeEpisodeSummary\(/);
    // Exactly two prepared writes assign the column, and both take their value from summaryFor.
    expect(src.match(/summary = \?/g) ?? []).toHaveLength(2);
    for (const call of ["promote.run(", "hold.run("]) {
      const i = src.indexOf(call);
      expect(i, `${call} not found in reflect.ts`).toBeGreaterThan(-1);
      expect(src.slice(i, i + 240)).toContain("summaryFor(");
    }
  });
});
