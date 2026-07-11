// THE-405 — asymmetric instruct-prefix seam at the provider factory. Pins: queries
// (input:"query") get queryPrefix, documents (default) get documentPrefix, and empty prefixes
// are the identity (no wrapper, byte-identical requests — the nomic-prefix lesson: prefixes are
// opt-in per model card, never ambient).
import { describe, expect, it } from "vitest";
import { createEmbeddingProvider } from "../src/embeddings";
import type { FetchFn } from "../src/embeddings/http";

function capture(): { fetchFn: FetchFn; bodies: Array<{ input: string[] }> } {
  const bodies: Array<{ input: string[] }> = [];
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    bodies.push(body);
    return new Response(JSON.stringify({ embeddings: body.input.map(() => [0.1, 0.2, 0.3]) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as FetchFn;
  return { fetchFn, bodies };
}

const QP = "Instruct: retrieve\nQuery: ";

describe("THE-405 asymmetric prefix seam", () => {
  it("prefixes queries with queryPrefix and documents with documentPrefix", async () => {
    const { fetchFn, bodies } = capture();
    const p = createEmbeddingProvider(
      { provider: "ollama", model: "m", dimensions: 3, queryPrefix: QP, documentPrefix: "doc: " },
      { fetchFn },
    );
    await p.embed(["what is x"], { input: "query" });
    await p.embed(["chunk text"]); // indexing path — document by default
    expect(bodies[0]?.input).toEqual([`${QP}what is x`]);
    expect(bodies[1]?.input).toEqual(["doc: chunk text"]);
  });

  it("empty prefixes are the identity (requests byte-identical)", async () => {
    const { fetchFn, bodies } = capture();
    const p = createEmbeddingProvider(
      { provider: "ollama", model: "m", dimensions: 3 },
      { fetchFn },
    );
    await p.embed(["plain"], { input: "query" });
    expect(bodies[0]?.input).toEqual(["plain"]);
  });

  it("query prefix alone leaves documents untouched", async () => {
    const { fetchFn, bodies } = capture();
    const p = createEmbeddingProvider(
      { provider: "ollama", model: "m", dimensions: 3, queryPrefix: QP },
      { fetchFn },
    );
    await p.embed(["chunk text"]);
    expect(bodies[0]?.input).toEqual(["chunk text"]);
  });
});
