import { ObsidianTcError, err } from "@obsidian-tc/shared";
import { describe, expect, it } from "vitest";

// M2 (G4.M2 / THE-178) extends the M1 taxonomy with the G2.1 Domain-6 search +
// retrieval-substrate codes. Retryable flags mirror the G2.1 taxonomy table:
// backend/timeout/unreachable are retryable; parse/missing are not.
describe("M2 error taxonomy (G2.1 Domain 6)", () => {
  it("exposes the six M2 codes via factories", () => {
    expect(err.embeddingProviderError().code).toBe("embedding_provider_error");
    expect(err.operationTimeout().code).toBe("operation_timeout");
    expect(err.dqlError().code).toBe("dql_error");
    expect(err.jsonlogicError().code).toBe("jsonlogic_error");
    expect(err.pluginMissing().code).toBe("plugin_missing");
    expect(err.pluginUnreachable().code).toBe("plugin_unreachable");
  });

  it("marks transient backend/timeout/unreachable retryable; parse/missing not", () => {
    expect(err.embeddingProviderError().retryable).toBe(true);
    expect(err.operationTimeout().retryable).toBe(true);
    expect(err.pluginUnreachable().retryable).toBe(true);
    expect(err.dqlError().retryable).toBe(false);
    expect(err.jsonlogicError().retryable).toBe(false);
    expect(err.pluginMissing().retryable).toBe(false);
  });

  it("round-trips details through ObsidianTcError.toJSON", () => {
    const e = err.embeddingProviderError("ollama down", { provider: "ollama" });
    expect(e).toBeInstanceOf(ObsidianTcError);
    expect(e.toJSON()).toMatchObject({
      code: "embedding_provider_error",
      retryable: true,
      details: { provider: "ollama" },
    });
  });
});
