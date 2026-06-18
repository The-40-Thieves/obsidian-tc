import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObsidianTcError } from "@obsidian-tc/shared";
import { describe, expect, it } from "vitest";
import { detectJsonIndent, readJsonFile, serializeJson } from "../src/formats/json-config";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as ObsidianTcError).code;
  }
  throw new Error("expected a throw");
}

describe("formats/json-config", () => {
  it("detects tab vs space indentation", () => {
    expect(detectJsonIndent('{\n\t"a": 1\n}')).toBe("\t");
    expect(detectJsonIndent('{\n  "a": 1\n}')).toBe(2);
    expect(detectJsonIndent("{}")).toBe("\t");
  });

  it("returns exists:false with the empty default for a missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "obtc-json-"));
    try {
      const f = readJsonFile(join(dir, "nope.json"), { items: [] });
      expect(f.exists).toBe(false);
      expect(f.data).toEqual({ items: [] });
      expect(f.hash).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws invalid_input on malformed JSON and non-object roots", () => {
    const dir = mkdtempSync(join(tmpdir(), "obtc-json-"));
    try {
      writeFileSync(join(dir, "bad.json"), "{not json");
      writeFileSync(join(dir, "arr.json"), "[1,2,3]");
      expect(codeOf(() => readJsonFile(join(dir, "bad.json"), {}))).toBe("invalid_input");
      expect(codeOf(() => readJsonFile(join(dir, "arr.json"), {}))).toBe("invalid_input");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips a config preserving unknown keys and their order", () => {
    const dir = mkdtempSync(join(tmpdir(), "obtc-json-"));
    try {
      const onDisk = '{\n\t"items": [],\n\t"plugins": { "x": 1 },\n\t"vendorField": "keep"\n}\n';
      writeFileSync(join(dir, "c.json"), onDisk);
      const f = readJsonFile<{ items: unknown[]; plugins: unknown; vendorField: string }>(
        join(dir, "c.json"),
        { items: [], plugins: {}, vendorField: "" },
      );
      expect(f.exists).toBe(true);
      expect(f.indent).toBe("\t");
      (f.data.items as unknown[]).push({ type: "file", path: "a.md" });
      const out = serializeJson(f.data, f.indent, f.trailingNewline);
      const re = JSON.parse(out) as Record<string, unknown>;
      expect(Object.keys(re)).toEqual(["items", "plugins", "vendorField"]);
      expect(re.plugins).toEqual({ x: 1 });
      expect(re.vendorField).toBe("keep");
      expect((re.items as unknown[]).length).toBe(1);
      expect(out.endsWith("\n")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
