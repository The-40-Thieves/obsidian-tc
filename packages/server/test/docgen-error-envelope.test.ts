// docgen — error-envelope gate (THE-470 item 2). api-reference.md hand-copies the `acl_denied`
// recovery string byte-for-byte from `recoveryFor()`. It was correct when measured, and would go
// silently stale the first time someone reworded the hint. THE-470 says this class is "handled by
// deterministic gates rather than by generation", so this tests the gate rather than a renderer.
import { describe, expect, it } from "vitest";
import { checkEnvelope, findEnvelopes } from "../scripts/docgen/check-error-envelope";

const fence = (o: unknown) => `\`\`\`json\n${JSON.stringify(o, null, 2)}\n\`\`\``;

describe("findEnvelopes (THE-470)", () => {
  it("finds a block that carries a code plus at least one asserted field", () => {
    const md = fence({ code: "acl_denied", message: "path denied by folder ACL" });
    expect(findEnvelopes(md)).toHaveLength(1);
  });

  it("ignores a json block that is not an error envelope", () => {
    // The MCP request examples on the same page are `{jsonrpc, id, method, params}` — matching
    // those would make every doc example a fact to police.
    const md = fence({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} });
    expect(findEnvelopes(md)).toHaveLength(0);
  });

  it("ignores a bare code with nothing asserted about it", () => {
    // `{ "code": "x" }` states no fact that could drift, so policing it would only produce noise.
    expect(findEnvelopes(fence({ code: "acl_denied" }))).toHaveLength(0);
  });

  it("skips unparseable blocks instead of failing them", () => {
    // Plenty of doc JSON is deliberately elided. This gate is about field VALUES, not JSON hygiene.
    expect(findEnvelopes('```json\n{ "code": "acl_denied", ... }\n```')).toHaveLength(0);
  });

  it("finds envelopes shape-first, in any file", () => {
    // Keying on a filename would miss a NEW page pasting an envelope — the case this exists for.
    const md = `intro\n${fence({ code: "not_found", retryable: false })}\nmore\n${fence({ code: "throttled", retryable: true })}`;
    expect(findEnvelopes(md)).toHaveLength(2);
  });
});

describe("checkEnvelope (THE-470)", () => {
  it("passes an envelope that matches the live taxonomy", () => {
    expect(checkEnvelope("f.md", { code: "acl_denied", retryable: false })).toEqual([]);
  });

  it("rejects a code that does not exist", () => {
    const v = checkEnvelope("f.md", { code: "not_a_real_code", message: "x" });
    expect(v).toHaveLength(1);
    expect(v[0]?.field).toBe("code");
  });

  it("rejects a wrong message, retryable, or recovery — naming the field", () => {
    const v = checkEnvelope("f.md", {
      code: "acl_denied",
      message: "wrong message",
      retryable: true,
      recovery: "wrong hint",
    });
    expect(v.map((x) => x.field).sort()).toEqual(["message", "recovery", "retryable"]);
    // The report must carry BOTH sides — "these disagree" without the real value leaves the reader
    // to go find it, which is how a gate becomes something people mute.
    for (const x of v) expect(x.actual.length).toBeGreaterThan(0);
  });

  it("says nothing about fields the doc does not assert", () => {
    // A doc showing only `code` + `retryable` must not be failed for omitting `message`.
    expect(checkEnvelope("f.md", { code: "acl_denied", retryable: false })).toEqual([]);
  });
});
