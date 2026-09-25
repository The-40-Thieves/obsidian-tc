// THE-1122 review — the upgrade note: `retrieval.heads` names the stored-vs-configured embeddings
// provider mismatch (most commonly, an upgrade past the "ollama" -> "local" default change) rather
// than leaving an operator to notice an unexplained full reindex.
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

describe("retrieval.heads — stored-vs-configured embeddings provider upgrade note", () => {
  it("adds a note naming both providers when the stored fingerprint disagrees with the configured one", async () => {
    const r = await retrievalHeadsCheck({ ...BASE_VIEW, storedProviderMismatch: "ollama" }).run(
      ctx,
    );
    expect(r.notes?.some((n) => n.includes("'ollama'") && n.includes("'local'"))).toBe(true);
  });

  it("adds no note when there is no stored fingerprint at all (fresh install)", async () => {
    const r = await retrievalHeadsCheck(BASE_VIEW).run(ctx);
    expect(r.notes?.some((n) => n.includes("stored index was built with provider"))).toBeFalsy();
  });

  it("adds no note once the stored and configured providers agree (rebuild has caught up)", async () => {
    const r = await retrievalHeadsCheck({ ...BASE_VIEW, storedProviderMismatch: "local" }).run(ctx);
    expect(r.notes?.some((n) => n.includes("stored index was built with provider"))).toBeFalsy();
  });

  it("the note does not flip the check's overall status to a warning/fail — it's informational only", async () => {
    const r = await retrievalHeadsCheck({ ...BASE_VIEW, storedProviderMismatch: "ollama" }).run(
      ctx,
    );
    expect(r.status).toBe("ok");
  });
});
