// THE-680, follow-up from a cross-vendor review of the first cut.
//
// The first version of these tests called postJson DIRECTLY, passing the slot the assertion then
// checked. That proves providerHint's switch translates a slot correctly — and proves nothing about
// whether any given ADAPTER declares the right slot. Flipping http-rerank.ts from "reranker" to
// "embeddings" would have typechecked and stayed green, which is precisely the bug THE-680 reported.
//
// These drive a FAILING request through each real adapter and assert the hint the operator would
// actually see. The mapping from call site to config key is the claim; this is what tests it.
import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { createEmbeddingProvider } from "../src/embeddings";
import { bgeM3VllmEncode } from "../src/embeddings/bge-m3";
import { bgeModelClient } from "../src/model/bge";
import { teiModelClient } from "../src/model/tei";
import { openAiCompatibleProvider } from "../src/providers/http-embeddings";
import { cohereCompatibleReranker } from "../src/providers/http-rerank";

/** Every adapter here builds its request through postJson, so a 401 exercises the same hint path an
 *  unreachable or unauthenticated endpoint would in production. */
const unauthorized: typeof fetch = async () =>
  new Response("unauthorized", { status: 401, statusText: "Unauthorized" });

async function hintFrom(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    expect(e).toBeInstanceOf(ObsidianTcError);
    return String((e as ObsidianTcError).details?.hint ?? "");
  }
  throw new Error("expected the adapter to throw");
}

describe("the hint each ADAPTER produces names its own config block", () => {
  it("cohere-compatible reranker points at reranker.apiKey", async () => {
    const rerank = cohereCompatibleReranker({
      model: "rerank-v3.5",
      baseUrl: "http://127.0.0.1:9/v2",
      fetchFn: unauthorized,
    });
    const hint = await hintFrom(() => rerank("q", ["a", "b"], 2));
    expect(hint).toContain("reranker.apiKey");
    // The regression itself: this adapter used to send its operator to the embeddings block.
    expect(hint).not.toContain("embeddings.apiKey");
  });

  it("openai-compatible embedder points at embeddings.apiKey", async () => {
    const p = openAiCompatibleProvider({
      model: "text-embedding-3-small",
      dimensions: 1536,
      baseUrl: "http://127.0.0.1:9/v1",
      fetchFn: unauthorized,
    });
    const hint = await hintFrom(() => p.embed(["a"]));
    expect(hint).toContain("embeddings.apiKey");
    expect(hint).not.toContain("reranker.apiKey");
  });

  // The second reranker on this transport. Its credential is the model-tier block's authToken, so
  // BOTH of the other answers would be wrong for it — and no grep for "rerank" in the ticket's
  // terms would have found it.
  it("bge-reranker points at embeddings.modelTier.full.authToken", async () => {
    const client = bgeModelClient({
      baseUrl: "http://127.0.0.1:9",
      dimensions: 1024,
      fetchFn: unauthorized,
    });
    const hint = await hintFrom(() =>
      // rerank is optional on ModelClient; bgeModelClient always provides it.
      // biome-ignore lint/style/noNonNullAssertion: asserted by the adapter's own contract
      client.rerank!({ query: "q", documents: ["a", "b"], topN: 2 }),
    );
    expect(hint).toContain("embeddings.modelTier.full.authToken");
    expect(hint).not.toContain("reranker.apiKey");
    expect(hint).not.toMatch(/set embeddings\.apiKey/);
  });

  it("bge-m3 encode points at embeddings.modelTier.full.authToken", async () => {
    const client = bgeModelClient({
      baseUrl: "http://127.0.0.1:9",
      dimensions: 1024,
      fetchFn: unauthorized,
    });
    const hint = await hintFrom(() => client.embed({ texts: ["a"] }));
    expect(hint).toContain("embeddings.modelTier.full.authToken");
  });

  // TEI carries no token in its options and sets no headers: naming any key would be a lie.
  it("TEI says no credential applies, naming no key", async () => {
    const client = teiModelClient({
      baseUrl: "http://127.0.0.1:9",
      dimensions: 1024,
      fetchFn: unauthorized,
    });
    const hint = await hintFrom(() => client.embed({ texts: ["a"] }));
    expect(hint).toMatch(/no credential/);
    expect(hint).not.toContain("apiKey");
    expect(hint).not.toContain("authToken");
  });

  it("bare-vLLM bge-m3 says no credential applies, naming no key", async () => {
    const hint = await hintFrom(() =>
      bgeM3VllmEncode(["a"], { baseUrl: "http://127.0.0.1:9/v1", fetchFn: unauthorized }),
    );
    expect(hint).toMatch(/no credential/);
    expect(hint).not.toContain("apiKey");
  });

  it("ollama keeps its own first-run advice and names no key", async () => {
    const p = createEmbeddingProvider(
      { provider: "ollama", model: "nomic-embed-text", dimensions: 768 },
      { fetchFn: unauthorized },
    );
    const hint = await hintFrom(() => p.embed(["a"]));
    expect(hint).toContain("ollama pull");
    expect(hint).not.toContain("apiKey");
  });

  it("cohere embedder points at embeddings.apiKey", async () => {
    const p = createEmbeddingProvider(
      { provider: "cohere", model: "embed-v4.0", dimensions: 1024 },
      { fetchFn: unauthorized },
    );
    const hint = await hintFrom(() => p.embed(["a"]));
    expect(hint).toContain("embeddings.apiKey");
    expect(hint).not.toContain("reranker.apiKey");
  });
});

// The slot must be what decides, not the provider name. An earlier revision short-circuited on
// provider === "ollama" BEFORE reading the slot, so a caller could declare "reranker" and still be
// handed a hint naming embeddings.model — reintroducing the wrong-config-block failure one branch
// above the fix. postJson is exported, so both fields are independently reachable inputs.
describe("credentialSlot is authoritative over the provider name", () => {
  it("a reranker-slot call never yields embeddings advice, even for provider 'ollama'", async () => {
    const { postJson } = await import("../src/embeddings/http");
    const hint = await hintFrom(() =>
      postJson({
        url: "http://127.0.0.1:9/rerank",
        body: {},
        provider: "ollama",
        credentialSlot: "reranker",
        fetchFn: unauthorized,
      }),
    );
    expect(hint).toContain("reranker.apiKey");
    expect(hint).not.toContain("ollama pull");
    expect(hint).not.toContain("embeddings.model");
  });
});
