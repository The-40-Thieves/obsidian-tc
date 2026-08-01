// Opening the enum moves typo detection from parse time to resolve time. Only acceptable if the
// resolve error is BETTER than the Zod one: it must name every valid option.
import { describe, expect, it } from "vitest";
import { createEmbeddingProvider } from "../src/embeddings";
import { embeddingsProviderNames } from "../src/providers/registry";

describe("unknown embeddings provider", () => {
  it("throws naming the offending value", () => {
    expect(() => createEmbeddingProvider({ provider: "olama", model: "m", dimensions: 3 })).toThrow(/olama/);
  });

  it("lists EVERY registered name in the message", () => {
    let message = "";
    try {
      createEmbeddingProvider({ provider: "olama", model: "m", dimensions: 3 });
    } catch (e) {
      message = JSON.stringify(e);
    }
    expect(embeddingsProviderNames().length).toBeGreaterThan(0); // floor: never vacuous
    for (const name of embeddingsProviderNames()) expect(message).toContain(name);
  });
});
