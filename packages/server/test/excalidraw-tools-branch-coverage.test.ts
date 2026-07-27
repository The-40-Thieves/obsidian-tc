// THE-602: branch-coverage top-up for src/tools/m4/excalidraw-tools.ts. Every test
// here asserts real caller-visible behavior (a thrown error's code, a returned
// field, or the exact bridge request body) — never just "the branch executed".
// Companion file to test/excalidraw.test.ts, which already covers the primary
// proxy/degrade/HITL paths; this file targets the filesystem parser's edge cases
// (malformed/absent sections, non-object JSON, missing files) and the
// presence/absence ternaries in the create/update request bodies.
import { afterEach, describe, expect, it } from "vitest";
import type { FakeRequestInfo } from "../src/bridge";
import { type M4Vault, makeM4Vault } from "./m4-helpers";

function reqAt(v: M4Vault, i: number): FakeRequestInfo {
  const r = v.bridgeRequests[i];
  if (!r) throw new Error(`expected a bridge request at index ${i}`);
  return r;
}

function bodyOf(req: FakeRequestInfo): Record<string, unknown> {
  return JSON.parse(req.body ?? "{}") as Record<string, unknown>;
}

describe("read_excalidraw source=filesystem — path/extension validation", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  it("rejects a path with neither .excalidraw nor .excalidraw.md extension", async () => {
    v = makeM4Vault({ files: { "notes/plain.md": "not a drawing" } });
    const res = await v.call("read_excalidraw", {
      vault: "test",
      path: "notes/plain.md",
      source: "filesystem",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("invalid_input");
  });

  it("reports note_not_found for a missing .excalidraw file", async () => {
    v = makeM4Vault({});
    const res = await v.call("read_excalidraw", {
      vault: "test",
      path: "gone.excalidraw",
      source: "filesystem",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("note_not_found");
  });
});

describe("read_excalidraw source=filesystem — parseJson edge cases", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  it("rejects unparseable JSON in a .excalidraw file", async () => {
    v = makeM4Vault({ files: { "bad.excalidraw": "{ not json" } });
    const res = await v.call("read_excalidraw", {
      vault: "test",
      path: "bad.excalidraw",
      source: "filesystem",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("invalid_input");
  });

  it("rejects valid JSON that is not a drawing object (array)", async () => {
    v = makeM4Vault({ files: { "arr.excalidraw": "[1,2,3]" } });
    const res = await v.call("read_excalidraw", {
      vault: "test",
      path: "arr.excalidraw",
      source: "filesystem",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("invalid_input");
  });

  it("rejects valid JSON that is not a drawing object (primitive)", async () => {
    v = makeM4Vault({ files: { "num.excalidraw": "42" } });
    const res = await v.call("read_excalidraw", {
      vault: "test",
      path: "num.excalidraw",
      source: "filesystem",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("invalid_input");
  });

  it("defaults elements to [] when the drawing object has no elements array", async () => {
    v = makeM4Vault({ files: { "empty.excalidraw": JSON.stringify({ type: "excalidraw" }) } });
    const res = await v.call("read_excalidraw", {
      vault: "test",
      path: "empty.excalidraw",
      source: "filesystem",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const d = res.data as { elements: unknown[]; element_count: number };
      expect(d.elements).toEqual([]);
      expect(d.element_count).toBe(0);
    }
  });

  it("format='elements' omits the text field entirely", async () => {
    const doc = JSON.stringify({
      type: "excalidraw",
      elements: [{ id: "t", type: "text", text: "hidden" }],
    });
    v = makeM4Vault({ files: { "el-only.excalidraw": doc } });
    const res = await v.call("read_excalidraw", {
      vault: "test",
      path: "el-only.excalidraw",
      format: "elements",
      source: "filesystem",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const d = res.data as Record<string, unknown>;
      expect(d.element_count).toBe(1);
      expect("text" in d).toBe(false);
    }
  });
});

describe("read_excalidraw source=filesystem — .excalidraw.md section parsing", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  it("falls back to an empty string when '## Text Elements' is absent", async () => {
    // No "## Text Elements" heading at all, and the drawing's only element is a
    // non-text shape, so parseMd's `p.text || text` fallback also resolves to "".
    const drawing = JSON.stringify({
      type: "excalidraw",
      elements: [{ id: "r", type: "rectangle" }],
    });
    const md = `## Drawing\n\`\`\`json\n${drawing}\n\`\`\`\n`;
    v = makeM4Vault({ files: { "no-text-section.excalidraw.md": md } });
    const res = await v.call("read_excalidraw", {
      vault: "test",
      path: "no-text-section.excalidraw.md",
      source: "filesystem",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const d = res.data as { text: string; compressed: boolean; element_count: number };
      expect(d.text).toBe("");
      expect(d.compressed).toBe(false);
      expect(d.element_count).toBe(1);
    }
  });

  it("takes the text section to end-of-file when no heading follows it", async () => {
    // "## Text Elements" is present but nothing follows, so sectionBody's `next < 0`
    // branch fires; drawingJson also finds no "## Drawing" section, so the parse
    // falls back to elements: [] / compressed: true with the section body as text.
    const md = "## Text Elements\nsome extracted text\n";
    v = makeM4Vault({ files: { "text-only.excalidraw.md": md } });
    const res = await v.call("read_excalidraw", {
      vault: "test",
      path: "text-only.excalidraw.md",
      source: "filesystem",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const d = res.data as { text: string; compressed: boolean; elements: unknown[] };
      expect(d.text).toBe("some extracted text");
      expect(d.compressed).toBe(true);
      expect(d.elements).toEqual([]);
    }
  });

  it("falls back to text-only when '## Drawing' has no fenced code block", async () => {
    const md = "## Text Elements\nplain text here\n\n## Drawing\nno fence in sight\n";
    v = makeM4Vault({ files: { "no-fence.excalidraw.md": md } });
    const res = await v.call("read_excalidraw", {
      vault: "test",
      path: "no-fence.excalidraw.md",
      source: "filesystem",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const d = res.data as { text: string; compressed: boolean };
      expect(d.compressed).toBe(true);
      expect(d.text).toBe("plain text here");
    }
  });
});

describe("read_excalidraw source=filesystem — embedded_files mime_type derivation", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  it("derives mime_type per-entry: string mimeType, missing, non-object, and falsy value", async () => {
    const doc = JSON.stringify({
      type: "excalidraw",
      elements: [],
      files: {
        withMime: { mimeType: "image/png" },
        noMime: {},
        notAnObject: "just-a-string",
        falsy: null,
      },
    });
    v = makeM4Vault({ files: { "files.excalidraw": doc } });
    const res = await v.call("read_excalidraw", {
      vault: "test",
      path: "files.excalidraw",
      source: "filesystem",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const d = res.data as { embedded_files: Array<{ id: string; mime_type: string | null }> };
      const byId = Object.fromEntries(d.embedded_files.map((f) => [f.id, f.mime_type]));
      expect(byId.withMime).toBe("image/png");
      expect(byId.noMime).toBeNull();
      expect(byId.notAnObject).toBeNull();
      expect(byId.falsy).toBeNull();
    }
  });
});

describe("read_excalidraw source=auto — plugin_unreachable also falls back", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  it("falls back to the filesystem when the companion is unreachable, not just missing", async () => {
    const doc = JSON.stringify({
      type: "excalidraw",
      elements: [{ id: "t", type: "text", text: "recovered" }],
    });
    v = makeM4Vault({
      snapshot: { companion: "unreachable", plugins: {} },
      files: { "d.excalidraw": doc },
    });
    const res = await v.call("read_excalidraw", {
      vault: "test",
      path: "d.excalidraw",
      source: "auto",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as { text: string }).text).toBe("recovered");
    // The degradation gate fires before any request is dispatched, same as plugin_missing.
    expect(v.bridgeRequests).toHaveLength(0);
  });
});

describe("create_excalidraw — optional body fields", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  it("includes template and elements in the write body when provided", async () => {
    v = makeM4Vault({
      installed: ["excalidraw"],
      routes: {
        "POST /obsidian-tc/v1/excalidraw/write": { body: { ok: true, result: { created: true } } },
      },
    });
    const res = await v.call("create_excalidraw", {
      vault: "test",
      path: "Drawings/Plan.excalidraw.md",
      template: "blank",
      elements: [{ id: "e1", type: "rectangle" }],
    });
    expect(res.ok).toBe(true);
    const body = bodyOf(reqAt(v, 0));
    expect(body.template).toBe("blank");
    expect(body.elements).toEqual([{ id: "e1", type: "rectangle" }]);
  });
});

describe("update_excalidraw — optional body fields", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  it("omits add_elements and includes remove/update fields when only those are given", async () => {
    v = makeM4Vault({
      installed: ["excalidraw"],
      routes: {
        "POST /obsidian-tc/v1/excalidraw/write": { body: { ok: true, result: { updated: 3 } } },
      },
    });
    const res = await v.call("update_excalidraw", {
      vault: "test",
      path: "Drawings/Plan.excalidraw.md",
      remove_element_ids: ["r1"],
      update_elements: { e2: { x: 10 } },
      update_app_state: { zoom: 1.5 },
    });
    expect(res.ok).toBe(true);
    const body = bodyOf(reqAt(v, 0));
    expect("add_elements" in body).toBe(false);
    expect(body.remove_element_ids).toEqual(["r1"]);
    expect(body.update_elements).toEqual({ e2: { x: 10 } });
    expect(body.update_app_state).toEqual({ zoom: 1.5 });
  });
});
