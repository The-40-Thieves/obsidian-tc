// Every writer that has an overwrite:false / create-only mode commits exclusively. The stale-check
// is simulated deterministically: noteExists() is made to claim the destination is free while a file
// already sits there — exactly what another process creating the path between the check and the
// write looks like. Before the fix each of these tools replaced the file; now the commit refuses.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildBulkTools } from "../src/tools/m6/bulk-tools";
import { makeTestVault } from "./m1-helpers";
import { makeM3Vault } from "./m3-helpers";
import { makeM6Vault } from "./m6-helpers";

// Destination basenames the stale check lies about. `[\\/]`: on Windows `abs` uses backslashes; a
// `/`-only pattern never matched there, so the race was not simulated and upsert hit the real file.
const STALE = /[\\/](dest\.(md|png|canvas|base)|b-dest\.md)$/;
vi.mock("../src/vault/notes-io", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vault/notes-io")>();
  return {
    ...actual,
    noteExists: (abs: string) => (STALE.test(abs) ? { exists: false } : actual.noteExists(abs)),
  };
});

const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");

function code(r: ToolResult): string {
  return r.ok ? "ok" : r.error.code;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

describe("write_note create / upsert", () => {
  it.each(["create", "upsert"])(
    "mode %s does not replace a file that appeared after the check",
    async (mode) => {
      const v = makeTestVault({ files: { "dest.md": "ORIGINAL" } });
      cleanups.push(v.cleanup);
      const r = await v.call("write_note", {
        vault: "test",
        path: "dest.md",
        content: "CLOBBER",
        mode,
      });
      expect(code(r)).toBe("note_exists");
      expect(v.read("dest.md")).toBe("ORIGINAL");
    },
  );
});

describe("move_note / copy_note", () => {
  it("move_note keeps the existing destination and the source", async () => {
    const v = makeTestVault({ files: { "dest.md": "ORIGINAL", "src.md": "SRC" } });
    cleanups.push(v.cleanup);
    const r = await v.call("move_note", { vault: "test", from: "src.md", to: "dest.md" });
    expect(code(r)).toBe("note_exists");
    expect(v.read("dest.md")).toBe("ORIGINAL");
    expect(v.read("src.md")).toBe("SRC");
  });
  it("copy_note keeps the existing destination", async () => {
    const v = makeTestVault({ files: { "dest.md": "ORIGINAL", "src.md": "SRC" } });
    cleanups.push(v.cleanup);
    const r = await v.call("copy_note", { vault: "test", from: "src.md", to: "dest.md" });
    expect(code(r)).toBe("note_exists");
    expect(v.read("dest.md")).toBe("ORIGINAL");
  });
});

describe("write_attachment / move_attachment / create_canvas / create_base", () => {
  it("write_attachment", async () => {
    const v = makeM3Vault();
    cleanups.push(v.cleanup);
    writeFileSync(join(v.root, "dest.png"), "ORIGINAL");
    const r = await v.call("write_attachment", {
      vault: "test",
      path: "dest.png",
      content: PNG_B64,
    });
    expect(code(r)).toBe("note_exists");
    expect(readFileSync(join(v.root, "dest.png"), "utf8")).toBe("ORIGINAL");
  });
  it("move_attachment", async () => {
    const v = makeM3Vault({ files: { "src.png": "SRC" } });
    cleanups.push(v.cleanup);
    writeFileSync(join(v.root, "dest.png"), "ORIGINAL");
    const r = await v.call("move_attachment", { vault: "test", from: "src.png", to: "dest.png" });
    expect(code(r)).toBe("note_exists");
    expect(readFileSync(join(v.root, "dest.png"), "utf8")).toBe("ORIGINAL");
    expect(v.exists("src.png")).toBe(true);
  });
  it("create_canvas", async () => {
    const v = makeM3Vault({ files: { "dest.canvas": "ORIGINAL" } });
    cleanups.push(v.cleanup);
    const r = await v.call("create_canvas", {
      vault: "test",
      path: "dest.canvas",
      nodes: [],
      edges: [],
    });
    expect(code(r)).toBe("note_exists");
    expect(v.read("dest.canvas")).toBe("ORIGINAL");
  });
  it("create_base", async () => {
    const v = makeM3Vault({ files: { "dest.base": "ORIGINAL" } });
    cleanups.push(v.cleanup);
    const r = await v.call("create_base", {
      vault: "test",
      path: "dest.base",
      base: { views: [{ type: "table", name: "t" }] },
    });
    expect(code(r)).toBe("note_exists");
    expect(v.read("dest.base")).toBe("ORIGINAL");
  });
});

describe("bulk_create_notes / bulk_move_notes", () => {
  const register = (
    r: import("../src/mcp/registry").ToolRegistry,
    d: import("../src/tools/m6/shared").M6Deps,
  ) => {
    for (const t of buildBulkTools(d)) r.register(t);
  };

  it("bulk_create_notes (create) fails the item and leaves the file", async () => {
    const v = makeM6Vault({ register, files: { "b-dest.md": "ORIGINAL" } });
    cleanups.push(v.cleanup);
    const r = await v.callConfirmed("bulk_create_notes", {
      vault: "test",
      items: [{ path: "b-dest.md", content: "CLOBBER" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const d = r.data as { failed: number; results: Array<{ error?: { code: string } }> };
      expect(d.failed).toBe(1);
      expect(d.results[0]?.error?.code).toBe("note_exists");
    }
    expect(v.read("b-dest.md")).toBe("ORIGINAL");
  });

  it("bulk_move_notes (real run) fails the row and keeps the destination and the source", async () => {
    const v = makeM6Vault({ register, files: { "b-dest.md": "ORIGINAL", "b-src.md": "SRC" } });
    cleanups.push(v.cleanup);
    const r = await v.callConfirmed("bulk_move_notes", {
      vault: "test",
      moves: [{ from: "b-src.md", to: "b-dest.md" }],
      dry_run: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const d = r.data as { results: Array<{ ok: boolean; error?: { code: string } }> };
      expect(d.results[0]?.ok).toBe(false);
      expect(d.results[0]?.error?.code).toBe("note_exists");
    }
    expect(v.read("b-dest.md")).toBe("ORIGINAL");
    expect(v.read("b-src.md")).toBe("SRC");
  });
});
