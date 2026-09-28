// GH #995 fix round 2 review, finding 5: `retrieval.heads`' `details.dense` always said
// "configured (…)" no matter WHERE that provider identity actually came from — an operator could
// not tell "I set this" apart from "the server kept this from my existing index" apart from "this
// is just the zero-config default" from the check output alone, despite `EmbeddingsProviderSource`
// naming all four cases. `details.denseSource` names it explicitly, for every case.
import { describe, expect, it } from "vitest";
import { type RetrievalHeadsView, retrievalHeadsCheck } from "../src/doctor/retrieval-heads";

const ctx = { serverVersion: "1.32.0" };

const BASE_VIEW: RetrievalHeadsView = {
  denseProvider: "local",
  denseModel: "nomic-embed-text-v1.5",
  denseDimensions: 768,
  multiVector: false,
  sparseEnabled: false,
  colbertEnabled: false,
};

describe("retrieval.heads — details.denseSource names the provider's source explicitly", () => {
  it("'configured' when the operator set embeddings.provider explicitly", async () => {
    const r = await retrievalHeadsCheck({ ...BASE_VIEW, denseProviderSource: "configured" }).run(
      ctx,
    );
    expect(r.details?.denseSource).toBe("configured");
  });

  it("'kept-from-index' when sticky resolution kept an existing index's provider", async () => {
    const r = await retrievalHeadsCheck({
      ...BASE_VIEW,
      denseProviderSource: "kept-from-index",
    }).run(ctx);
    expect(r.details?.denseSource).toBe("kept-from-index");
  });

  it("'ambiguous-orphaned-index' when a renamed vault id's rows could not be confirmed", async () => {
    const r = await retrievalHeadsCheck({
      ...BASE_VIEW,
      denseProviderSource: "ambiguous-orphaned-index",
    }).run(ctx);
    expect(r.details?.denseSource).toBe("ambiguous-orphaned-index");
  });

  it("'default' when the schema default applies", async () => {
    const r = await retrievalHeadsCheck({ ...BASE_VIEW, denseProviderSource: "default" }).run(ctx);
    expect(r.details?.denseSource).toBe("default");
  });

  it("falls back to 'default' when denseProviderSource is undefined (fresh install, no cache db yet)", async () => {
    const r = await retrievalHeadsCheck(BASE_VIEW).run(ctx);
    expect(r.details?.denseSource).toBe("default");
  });
});
