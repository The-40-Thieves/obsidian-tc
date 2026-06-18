import type { ObsidianTcError } from "@obsidian-tc/shared";
import { describe, expect, it } from "vitest";
import { parseCanvas, projectNode, serializeCanvas } from "../src/formats/canvas";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as ObsidianTcError).code;
  }
  throw new Error("expected a throw");
}

describe("formats/canvas codec", () => {
  it("parses a valid JSONCanvas document", () => {
    const raw = JSON.stringify({
      nodes: [{ id: "n1", type: "text", x: 0, y: 0, width: 100, height: 50, text: "hi" }],
      edges: [{ id: "e1", fromNode: "n1", toNode: "n1" }],
    });
    const p = parseCanvas(raw);
    expect(p.nodes).toHaveLength(1);
    expect(projectNode(p.nodes[0] as Record<string, unknown>)).toMatchObject({
      id: "n1",
      type: "text",
      text: "hi",
    });
  });

  it("rejects malformed JSON, array roots, and structurally invalid nodes with invalid_input", () => {
    expect(codeOf(() => parseCanvas("{not json"))).toBe("invalid_input");
    expect(codeOf(() => parseCanvas("[]"))).toBe("invalid_input");
    expect(
      codeOf(() => parseCanvas('{"nodes":[{"id":"n1","type":"text","x":0,"y":0,"width":100}]}')),
    ).toBe("invalid_input"); // missing height
  });

  it("treats empty text as an empty canvas", () => {
    const p = parseCanvas("");
    expect(p.nodes).toEqual([]);
    expect(p.edges).toEqual([]);
  });

  it("preserves unknown node/edge/top-level fields and key order across a round-trip", () => {
    const raw = JSON.stringify(
      {
        nodes: [
          {
            id: "n1",
            type: "text",
            x: 0,
            y: 0,
            width: 100,
            height: 50,
            text: "hi",
            styleAttributes: { shape: "pill" },
            customFlag: true,
          },
        ],
        edges: [],
        metadata: { frontmatter: { k: 1 } },
      },
      null,
      "\t",
    );
    const p = parseCanvas(raw);
    (p.nodes[0] as Record<string, unknown>).text = "changed";
    const out = serializeCanvas(p.raw);
    const re = JSON.parse(out) as {
      nodes: Record<string, unknown>[];
      metadata: unknown;
    };
    expect(re.nodes[0]?.text).toBe("changed");
    expect(re.nodes[0]?.styleAttributes).toEqual({ shape: "pill" });
    expect(re.nodes[0]?.customFlag).toBe(true);
    expect(re.metadata).toEqual({ frontmatter: { k: 1 } });
    // mutating `text` must not reorder the node's keys
    expect(Object.keys(re.nodes[0] ?? {})).toEqual([
      "id",
      "type",
      "x",
      "y",
      "width",
      "height",
      "text",
      "styleAttributes",
      "customFlag",
    ]);
  });
});
