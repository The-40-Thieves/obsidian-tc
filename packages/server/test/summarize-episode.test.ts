// THE-752 Tier 0 — the deterministic (no-LLM) agent_episodes.summary writer.
//
// Every field in the receipt is copied or tallied from columns episodes.ts already writes at
// capture; nothing here is inferred or generated, so there is no model-collapse surface to test
// against. What DOES need pinning: the template is a pure function (same inputs -> byte-identical
// JSON, every run — the idempotency contract evaluateEpisodes relies on for held rows that get
// re-evaluated), the verdict mapping is the ground-truth anchor and is never optional, and a
// NULL-verdict (unjudged) episode still produces a well-formed receipt rather than a hole.
import { describe, expect, it } from "vitest";
import {
  buildEpisodeSummary,
  episodeVerdict,
  serializeEpisodeSummary,
} from "../src/experiential/summarize-episode";

describe("episodeVerdict (THE-565/THE-726 vocabulary)", () => {
  it("maps the closed task_result set to a reader-facing enum", () => {
    expect(episodeVerdict(1)).toBe("pass");
    expect(episodeVerdict(-1)).toBe("fail");
    expect(episodeVerdict(0)).toBe("neutral");
    expect(episodeVerdict(null)).toBe("unjudged");
  });
});

describe("buildEpisodeSummary (THE-752 Tier 0 receipt)", () => {
  const fixture = {
    tool: "search_text",
    caller: "cave-agents-main",
    status: "ok",
    task_result: 1,
    tags: '["poison:none"]',
  };

  it("produces a receipt anchored on the observed verdict — the ground-truth field, never optional", () => {
    const summary = buildEpisodeSummary(fixture, { search_text: 3 });
    expect(summary).toEqual({
      intent: "search_text by cave-agents-main",
      verdict: "pass",
      status: "ok",
      tool_calls: { search_text: 3 },
      tags: ["poison:none"],
      generated_by: "deterministic-v1",
    });
  });

  it("is a pure function: identical inputs produce byte-identical JSON on every call", () => {
    const a = serializeEpisodeSummary(fixture, { search_text: 3 });
    const b = serializeEpisodeSummary(fixture, { search_text: 3 });
    const c = serializeEpisodeSummary({ ...fixture }, { search_text: 3 });
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it("a NULL-verdict (never judged) episode still produces a well-formed receipt", () => {
    const summary = buildEpisodeSummary(
      { tool: "read_note", caller: "cave-agents", status: "ok", task_result: null, tags: null },
      { read_note: 1 },
    );
    expect(summary.verdict).toBe("unjudged");
    expect(summary.intent).toBe("read_note by cave-agents");
    expect(summary.tags).toEqual([]);
  });

  it("falls back to 'unknown' rather than 'null'/'undefined' when tool or caller is absent", () => {
    const summary = buildEpisodeSummary(
      { tool: null, caller: null, status: "error", task_result: null, tags: null },
      {},
    );
    expect(summary.intent).toBe("unknown by unknown");
  });

  it("degrades malformed tags JSON to an empty list rather than throwing", () => {
    const summary = buildEpisodeSummary({ ...fixture, tags: "{not json" }, {});
    expect(summary.tags).toEqual([]);
  });

  it("drops non-string entries from a tags array rather than propagating them", () => {
    const summary = buildEpisodeSummary({ ...fixture, tags: '["ok", 5, null]' }, {});
    expect(summary.tags).toEqual(["ok"]);
  });
});
