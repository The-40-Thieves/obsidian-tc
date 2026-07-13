import { describe, expect, it } from "vitest";
import type { FetchFn } from "../src/embeddings/http";
import { teiModelClient } from "../src/model";

type InfoFixture = { model_id?: string; model_sha?: string } | "fail";

// A fetch that answers TEI's /v1/embeddings and /info from a fixture, recording each request so the
// adapter's request shape can be asserted. No live server, no models.
function fakeTei(cfg: {
  vectors: Record<string, number[]>;
  respModel?: string;
  info?: InfoFixture;
  reverse?: boolean;
  calls?: Array<{ url: string; body?: unknown }>;
}): FetchFn {
  const fn = async (input: unknown, init?: { body?: unknown; method?: string }) => {
    const url = String(input);
    cfg.calls?.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/info")) {
      if (cfg.info === "fail") return new Response("err", { status: 500 });
      return new Response(JSON.stringify(cfg.info ?? {}), { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    let data = body.input.map((t, index) => ({
      object: "embedding",
      embedding: cfg.vectors[t] ?? [],
      index,
    }));
    if (cfg.reverse) data = data.slice().reverse();
    return new Response(
      JSON.stringify({ object: "list", data, model: cfg.respModel ?? "srv/model" }),
      {
        status: 200,
      },
    );
  };
  return fn as unknown as FetchFn;
}

describe("teiModelClient (ModelClient.embed adapter)", () => {
  it("posts {input,model} to /v1/embeddings and returns vectors in request order with provenance", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    const mc = teiModelClient({
      baseUrl: "http://tei:8080/",
      dimensions: 2,
      model: "Qwen/Qwen3-Embedding-0.6B",
      fetchFn: fakeTei({
        vectors: { a: [1, 0], b: [0, 1] },
        info: { model_id: "Qwen/Qwen3-Embedding-0.6B", model_sha: "abc123" },
        reverse: true, // server returns out of order; the adapter must re-order by index
        calls,
      }),
    });
    const r = await mc.embed({ texts: ["a", "b"] });
    expect(r.vectors).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(r.dimensions).toBe(2);
    expect(r.normalized).toBe(true);
    expect(r.pooling).toBe("last-token");
    expect(r.model).toBe("Qwen/Qwen3-Embedding-0.6B");
    expect(r.revision).toBe("abc123"); // model_sha from /info
    const embedCall = calls.find((c) => c.url.endsWith("/v1/embeddings"));
    expect(embedCall?.url).toBe("http://tei:8080/v1/embeddings"); // trailing slash trimmed, /v1 appended
    expect(embedCall?.body).toEqual({ input: ["a", "b"], model: "Qwen/Qwen3-Embedding-0.6B" });
  });

  it("falls back to the config-pinned revision when /info is unreachable", async () => {
    const mc = teiModelClient({
      baseUrl: "http://tei:8080",
      dimensions: 2,
      revision: "pinned-sha",
      fetchFn: fakeTei({ vectors: { x: [1, 0] }, respModel: "srv/qwen", info: "fail" }),
    });
    const r = await mc.embed({ texts: ["x"] });
    expect(r.revision).toBe("pinned-sha");
    expect(r.model).toBe("srv/qwen"); // from the embeddings response when /info gives nothing
  });

  it("rejects a width mismatch via assertVectors", async () => {
    const mc = teiModelClient({
      baseUrl: "http://tei:8080",
      dimensions: 4, // expect 4, server returns width 2
      fetchFn: fakeTei({ vectors: { x: [1, 0] } }),
    });
    await expect(mc.embed({ texts: ["x"] })).rejects.toThrow();
  });

  it("short-circuits empty input without calling /v1/embeddings", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    const mc = teiModelClient({
      baseUrl: "http://tei:8080",
      dimensions: 2,
      model: "m",
      revision: "r",
      fetchFn: fakeTei({ vectors: {}, calls }),
    });
    const r = await mc.embed({ texts: [] });
    expect(r.vectors).toEqual([]);
    expect(calls.find((c) => c.url.endsWith("/v1/embeddings"))).toBeUndefined();
  });
});
