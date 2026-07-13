import { describe, expect, it } from "vitest";
import { createGatewayClient } from "../src/gateway";
import type { GenerationClient, ModelClient } from "../src/model";
import { fakeGenerationClient, fakeModelClient } from "../src/model";

describe("ModelClient port (fake)", () => {
  const mc: ModelClient = fakeModelClient({ dimensions: 8, model: "test/dense" });

  it("embed returns one L2-normalised vector per input, in order, with provenance", async () => {
    const r = await mc.embed({ texts: ["alpha beta", "gamma"] });
    expect(r.vectors).toHaveLength(2);
    expect(r.dimensions).toBe(8);
    expect(r.model).toBe("test/dense");
    expect(r.pooling).toBe("last-token");
    const v0 = r.vectors[0] ?? [];
    expect(v0).toHaveLength(8);
    const norm = Math.sqrt(v0.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it("embedFull returns aligned {dense,sparse,colbert} per input", async () => {
    const r = await mc.embedFull?.({ texts: ["one", "two", "three"] });
    expect(r?.items).toHaveLength(3);
    const first = r?.items[0];
    expect(first?.dense).toHaveLength(8);
    expect(first?.sparse).toEqual({});
    expect(first?.colbert).toEqual([]);
  });

  it("rerank sorts by score and honours topN", async () => {
    const r = await mc.rerank?.({
      query: "q",
      documents: ["short", "a much longer document", "mid"],
      topN: 2,
    });
    expect(r?.results).toHaveLength(2);
    expect(r?.results[0]?.index).toBe(1); // the longest document ranks first
  });
});

describe("GenerationClient port", () => {
  it("fake extract/synthesize/judge echo the last message under a role tag", async () => {
    const gc: GenerationClient = fakeGenerationClient();
    const out = await gc.judge({ messages: [{ role: "user", content: "hi" }] });
    expect(out.text).toBe("[judge] hi");
    expect(out.model).toBe("fake/judge");
  });

  it("the real GatewayClient structurally satisfies GenerationClient", () => {
    // Compile-time boundary check: GatewayClient is assignable to GenerationClient (rerank is the
    // only extra method). Construction makes no network call.
    const gc: GenerationClient = createGatewayClient({ baseUrl: "http://127.0.0.1:9/none" });
    expect(typeof gc.extract).toBe("function");
    expect(typeof gc.synthesize).toBe("function");
    expect(typeof gc.judge).toBe("function");
  });
});
