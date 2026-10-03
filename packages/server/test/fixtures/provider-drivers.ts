// One driver per outbound provider client, each making ONE real request through the client's DEFAULT
// transport (no fetchFn injected), so a test proves the shared policy fetch is what the client
// uses. Shared by provider-plain-http.test.ts (Node) and the Bun child that checks HTTP_PROXY.
// Every driver carries a secret in a bearer header or the body, and every one is answered by the
// same stub body below, which satisfies all of their parsers.
import { createBridgeClient } from "../../src/bridge/transport";
import { createEmbeddingProvider } from "../../src/embeddings";
import { createGatewayClient } from "../../src/gateway/client";
import { teiModelClient } from "../../src/model/tei";
import { createPlurClient } from "../../src/plur/client";
import { cohereCompatibleReranker } from "../../src/providers/http-rerank";

export const PROVIDER_SECRET = "sk-provider-secret";

/** What the stub server answers to every provider call. */
export const STUB_BODY = JSON.stringify({
  model: "m",
  data: [{ embedding: [0.1, 0.2], index: 0 }],
  choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
  results: [{ index: 0, relevance_score: 0.5 }],
  ok: true,
  result: { n: 1 },
});

export interface ProviderDriver {
  name: string;
  call(baseUrl: string): Promise<unknown>;
}

export const PROVIDER_DRIVERS: ProviderDriver[] = [
  {
    name: "embeddings (openai-compatible)",
    call: (baseUrl) =>
      createEmbeddingProvider({
        provider: "openai-compatible",
        model: "m",
        dimensions: 2,
        baseUrl,
        apiKey: PROVIDER_SECRET,
      }).embed(["vault text"], { sourcePaths: [] }),
  },
  {
    name: "reranker (cohere-compatible)",
    call: (baseUrl) =>
      cohereCompatibleReranker({ model: "m", baseUrl: `${baseUrl}/v2`, apiKey: PROVIDER_SECRET })(
        "q",
        ["vault text"],
        1,
        [],
      ),
  },
  {
    name: "gateway",
    call: (baseUrl) =>
      createGatewayClient({ baseUrl, token: PROVIDER_SECRET, maxAttempts: 1 }).extract({
        messages: [{ role: "user", content: "vault text" }],
        sourcePaths: [],
      }),
  },
  {
    name: "model tier (TEI dense)",
    call: (baseUrl) => teiModelClient({ baseUrl, dimensions: 2 }).embed({ texts: ["vault text"] }),
  },
  {
    name: "bridge (Obsidian Local REST API)",
    call: (baseUrl) =>
      createBridgeClient({ baseUrl, apiKey: PROVIDER_SECRET }).request({
        method: "POST",
        path: "/p",
        body: { text: "vault text" },
      }),
  },
  {
    name: "plur",
    call: (baseUrl) =>
      createPlurClient({ endpoint: baseUrl, apiKey: PROVIDER_SECRET })?.request({
        method: "POST",
        path: "/p",
        body: { text: "vault text" },
      }) ?? Promise.reject(new Error("no plur client")),
  },
];
