// `toMcpTool(def, maxResponseBytes?)` used to take the response budget as a bare optional second
// parameter, so the natural `defs.map(toMcpTool)` silently passed Array.prototype.map's INDEX as the
// budget: every whole-note reader after position 0 advertised a nonsense
// `anthropic/maxResultSizeChars`. The budget is now an options object, which makes that call a
// type error (a number is not an options bag) and, if it were ever forced through, harmless at
// runtime. This file is checked by `bun run typecheck`: an unused `@ts-expect-error` is itself a
// compile error, so the day the signature goes back to a positional number this file stops
// compiling.
import { describe, expect, it } from "vitest";
import { buildFullRegistry } from "../scripts/docgen/build-registry";
import { MAX_RESULT_SIZE_META_FIELD } from "../src/mcp/result-size";
import { toMcpTool, toMcpToolNoOutputSchema } from "../src/mcp/tool-projection";

describe("toMcpTool takes an options object, not a positional budget", () => {
  const defs = buildFullRegistry().list();

  it("existence floor: the registry has whole-note readers beyond index 0 to be mis-budgeted", () => {
    const readers = defs.map((d, i) => (d.wholeNotes ? i : -1)).filter((i) => i > 0);
    expect(readers.length).toBeGreaterThan(0);
  });

  it("point-free defs.map(toMcpTool) is a type error, and advertises no budget at run time", () => {
    // @ts-expect-error the index `.map` passes is not a `{ maxResponseBytes }` options bag
    const viaMap = defs.map(toMcpTool);
    expect(viaMap.filter((t) => t._meta?.[MAX_RESULT_SIZE_META_FIELD] !== undefined)).toEqual([]);
  });

  it("the same holds for toMcpToolNoOutputSchema", () => {
    // @ts-expect-error the index `.map` passes is not a `{ maxResponseBytes }` options bag
    const viaMap = defs.map(toMcpToolNoOutputSchema);
    expect(viaMap.filter((t) => t._meta?.[MAX_RESULT_SIZE_META_FIELD] !== undefined)).toEqual([]);
    expect(viaMap.every((t) => !("outputSchema" in t))).toBe(true);
  });

  it("an explicit { maxResponseBytes } still advertises the budget on whole-note readers", () => {
    const read = defs.find((d) => d.wholeNotes);
    if (!read) throw new Error("no wholeNotes tool in the registry");
    expect(toMcpTool(read, { maxResponseBytes: 200_000 })._meta?.[MAX_RESULT_SIZE_META_FIELD]).toBe(
      200_000,
    );
    expect(
      toMcpToolNoOutputSchema(read, { maxResponseBytes: 200_000 })._meta?.[
        MAX_RESULT_SIZE_META_FIELD
      ],
    ).toBe(200_000);
    expect(toMcpTool(read)._meta).toBeUndefined();
    expect(toMcpTool(read, {})._meta).toBeUndefined();
  });
});
