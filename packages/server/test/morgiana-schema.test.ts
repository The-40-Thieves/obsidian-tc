import {
  CloudEventSchema,
  MORGIANA_EVENT_TYPES,
  MorgianaEventDataSchema,
} from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";

describe("MORGIANA CloudEvents schema (G2.4)", () => {
  it("declares the spec event types plus additive extensions", () => {
    expect(MORGIANA_EVENT_TYPES).toHaveLength(10);
    expect(MORGIANA_EVENT_TYPES).toContain("tc.maintenance.sweep");
    expect(MORGIANA_EVENT_TYPES).toContain("tc.tool.call.completed");
    expect(MORGIANA_EVENT_TYPES).toContain("tc.server.shutdown");
  });

  it("validates a full tool-call CloudEvent envelope", () => {
    const ev = CloudEventSchema.parse({
      specversion: "1.0",
      id: "11111111-1111-1111-1111-111111111111",
      source: "obsidian-tc/main",
      type: "tc.tool.call.completed",
      time: "2026-06-18T12:00:00.000Z",
      data: {
        vault_id: "main",
        tool: "read_note",
        caller_hash: "c0ffee00",
        scopes_required: ["read:notes"],
        status: "ok",
        duration_ms: 12,
        result_size: 2048,
      },
    });
    expect(ev.datacontenttype).toBe("application/json"); // default applied
    expect(ev.data.tool).toBe("read_note");
    expect(ev.data.error).toBeNull(); // default
  });

  it("fills data defaults for a minimal lifecycle event (server.start)", () => {
    const data = MorgianaEventDataSchema.parse({ vault_id: "main" });
    expect(data).toMatchObject({
      vault_id: "main",
      tool: null,
      caller_hash: "system",
      scopes_required: [],
      status: null,
      count: null,
    });
  });

  it("rejects an unknown event type and a wrong specversion", () => {
    expect(
      CloudEventSchema.safeParse({
        specversion: "1.0",
        id: "x",
        source: "obsidian-tc/main",
        type: "tc.not.real",
        time: "t",
        data: { vault_id: "main" },
      }).success,
    ).toBe(false);
    expect(
      CloudEventSchema.safeParse({
        specversion: "0.3",
        id: "x",
        source: "obsidian-tc/main",
        type: "tc.server.start",
        time: "t",
        data: { vault_id: "main" },
      }).success,
    ).toBe(false);
  });
});
