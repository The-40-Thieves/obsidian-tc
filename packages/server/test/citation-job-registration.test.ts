// THE-717 — does the citation handler actually get REGISTERED, and more importantly does it stay
// UNregistered when it could not possibly do work?
//
// This repo keeps producing the same defect: correct code, complete tests, no scheduled caller
// (THE-698's evaluator, THE-717's citation pass, THE-719's gaps pass). The fix for the citation
// pass is a handler registration, and a registration is exactly the kind of thing that looks done
// because it compiles. Nothing tested `wireJobHandlers` before this file.
//
// The inverse cases matter MORE than the positive one. A handler registered without a transcript
// index would be enqueued on every tick, throw on a missing file, and dead-letter forever — or
// worse, registered without a gateway it would run stage-1-only and stamp every survivor
// `cited_in_response = 1`, which chunk_access_stats counts and note_quality weights at 0.6.
import { describe, expect, it } from "vitest";
import { wireJobHandlers } from "../src/runtime/plane-wiring";

/** Deps the citation gate never reads before deciding. Cast rather than constructed: building a
 *  real registry/acl/queue here would test those, not the gate. */
const stub = <T>(): T => ({}) as T;

function handlersWith(over: Record<string, unknown>): Set<string> {
  const { jobHandlers } = wireJobHandlers({
    registry: stub(),
    db: stub(),
    acl: stub(),
    jobQueue: stub(),
    roles: null,
    embeddingProvider: stub(),
    experientialOpen: false,
    experientialDb: stub(),
    vaults: [],
    ...over,
  } as never);
  return new Set(jobHandlers.keys());
}

const READY = {
  experientialOpen: true,
  experientialDb: stub(),
  roles: { judge: async () => ({ text: "{}", model: "m" }) },
  cacheDb: stub(),
  embed: async () => [[0]],
  citationInfer: { enabled: true, transcriptIndex: "/tmp/idx.jsonl" },
};

describe("THE-717: the citation job registers only when it could actually run", () => {
  it("registers with every condition met", () => {
    expect(handlersWith(READY).has("citation")).toBe(true);
  });

  it("does NOT register without a transcriptIndex — the real gate", () => {
    // A handler with no possible input is worse than an absent one: it reports success with zero
    // work forever, which is the exact shape THE-716/THE-717 kept finding.
    expect(handlersWith({ ...READY, citationInfer: { enabled: true } }).has("citation")).toBe(
      false,
    );
  });

  it("does NOT register when disabled, even with an index configured", () => {
    expect(
      handlersWith({
        ...READY,
        citationInfer: { enabled: false, transcriptIndex: "/tmp/idx.jsonl" },
      }).has("citation"),
    ).toBe(false);
  });

  it("does NOT register without a GATEWAY — this one is about note_quality, not symmetry", () => {
    // Without a judge the pass runs stage-1-only and stamps every survivor cited_in_response = 1
    // with state `candidate`. chunk_access_stats counts that as a citation and note_quality weights
    // citation rate at 0.6, so an unattended stage-1-only schedule would inflate 60% of every
    // quality score with rows no judge ever read. A human may still choose that mode at the CLI.
    expect(handlersWith({ ...READY, roles: null }).has("citation")).toBe(false);
  });

  it("does NOT register with the experiential store closed", () => {
    expect(handlersWith({ ...READY, experientialOpen: false }).has("citation")).toBe(false);
  });

  it("does NOT register without the AUTHORED store or the embedder", () => {
    // Stage 1 reads chunk content and stored vectors from the cache db and embeds transcript
    // blocks. Missing either is a wiring bug, and registering anyway would surface it as a
    // dead-lettered job rather than an absent one.
    expect(handlersWith({ ...READY, cacheDb: undefined }).has("citation")).toBe(false);
    expect(handlersWith({ ...READY, embed: undefined }).has("citation")).toBe(false);
  });

  it("leaves the OTHER handlers' registration untouched", () => {
    // A regression guard: the citation branch sits beside note-quality and the gateway jobs, and
    // it must not change when they register.
    const withCitation = handlersWith(READY);
    expect(withCitation.has("note-quality")).toBe(true);
    expect(withCitation.has("synthesis")).toBe(true);
    const noGateway = handlersWith({ ...READY, roles: null });
    expect(noGateway.has("note-quality")).toBe(true);
    expect(noGateway.has("synthesis")).toBe(false);
  });
});
