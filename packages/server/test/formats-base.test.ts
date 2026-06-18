import type { ObsidianTcError } from "@obsidian-tc/shared";
import { describe, expect, it } from "vitest";
import { parseBase, selectView, serializeBase } from "../src/formats/base";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as ObsidianTcError).code;
  }
  throw new Error("expected a throw");
}

const SAMPLE = `source:
  type: tag
  value: project
views:
  - name: Table
    type: table
    order:
      - file.name
properties:
  status:
    displayName: Status
`;

describe("formats/base codec", () => {
  it("parses a valid .base document and selects views", () => {
    const { raw } = parseBase(SAMPLE);
    expect((raw.source as Record<string, unknown>).type).toBe("tag");
    expect(selectView(raw)?.name).toBe("Table");
    expect(selectView(raw, "Table")?.type).toBe("table");
    expect(selectView(raw, "missing")).toBeUndefined();
  });

  it("rejects malformed YAML, array roots, and scalar roots with bases_syntax_error", () => {
    expect(codeOf(() => parseBase("foo: [unclosed"))).toBe("bases_syntax_error");
    expect(codeOf(() => parseBase("- a\n- b"))).toBe("bases_syntax_error");
    expect(codeOf(() => parseBase("just a string"))).toBe("bases_syntax_error");
  });

  it("preserves unknown top-level and per-view fields across a round-trip", () => {
    const { raw } = parseBase(SAMPLE);
    (raw.views as Record<string, unknown>[])[0] = {
      ...(raw.views as Record<string, unknown>[])[0],
      name: "Renamed",
    };
    const out = serializeBase(raw);
    const re = parseBase(out).raw;
    expect((re.views as Record<string, unknown>[])[0]?.name).toBe("Renamed");
    // `order` is not in the G2.1 model but must survive
    expect((re.views as Record<string, unknown>[])[0]?.order).toEqual(["file.name"]);
    // `properties` is a real Bases key absent from the G2.1 model — must survive
    expect(re.properties).toEqual({ status: { displayName: "Status" } });
  });
});
