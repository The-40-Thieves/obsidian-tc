// POST /files/open — the companion side of the server's show_file_in_obsidian. It opens ONE existing
// in-vault file in the workspace and nothing else: it takes a vault-relative path (never a URI or a
// command), refuses absolute/traversal paths before touching the vault, and answers a folder or an
// unknown path as note_not_found rather than creating anything.
import { TFile } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { buildFilesRoutes } from "../src/routes/files";
import type { BridgeRes, InternalApp } from "../src/routes/types";

function makeRes() {
  const seen: { body?: unknown; calls: number } = { calls: 0 };
  const res: BridgeRes = {
    status() {
      return res;
    },
    json(body: unknown) {
      seen.body = body;
      seen.calls += 1;
    },
  };
  return { res, seen };
}

function makeApp(files: Record<string, TFile> = {}) {
  const openFile = vi.fn(async () => {});
  const leaf = { openFile };
  const getLeaf = vi.fn(() => leaf);
  const revealLeaf = vi.fn(async () => {});
  const lookups: string[] = [];
  const app = {
    vault: {
      getAbstractFileByPath: (p: string) => {
        lookups.push(p);
        return files[p] ?? null;
      },
    },
    workspace: { getLeaf, revealLeaf },
  } as unknown as InternalApp;
  return { app, openFile, getLeaf, revealLeaf, lookups };
}

const tfile = (path: string): TFile =>
  Object.assign(new TFile(), { path, basename: "x", extension: "md" });

const handler = (app: InternalApp) => {
  const d = buildFilesRoutes(app).find((r) => r.path === "/files/open");
  if (!d) throw new Error("no /files/open route");
  return d.handler;
};

describe("POST /files/open", () => {
  it("is a POST route at /files/open", () => {
    const { app } = makeApp();
    expect(buildFilesRoutes(app).map((r) => `${r.method} ${r.path}`)).toEqual([
      "post /files/open",
      "get /files/active",
    ]);
  });

  it("opens an existing file in the active leaf and reveals it", async () => {
    const f = tfile("Notes/a b.md");
    const m = makeApp({ "Notes/a b.md": f });
    const { res, seen } = makeRes();
    await handler(m.app)({ body: { path: "Notes/a b.md" } }, res);
    expect(seen.body).toEqual({ ok: true, result: { opened: true, path: "Notes/a b.md" } });
    expect(m.getLeaf).toHaveBeenCalledWith(false);
    expect(m.openFile).toHaveBeenCalledWith(f);
    expect(m.revealLeaf).toHaveBeenCalledTimes(1);
  });

  it("looks the path up normalized (unicode, # and spaces survive; doubled slashes collapse)", async () => {
    const rel = "Notes/日本語 #1 (draft).md";
    const m = makeApp({ [rel]: tfile(rel) });
    const { res, seen } = makeRes();
    await handler(m.app)({ body: { path: "Notes//日本語 #1 (draft).md" } }, res);
    expect(seen.body).toMatchObject({ ok: true });
    expect(m.lookups).toEqual([rel]);
  });

  it("answers an unknown path (or a folder) as note_not_found and opens nothing", async () => {
    const m = makeApp();
    const { res, seen } = makeRes();
    await handler(m.app)({ body: { path: "Notes/missing.md" } }, res);
    expect(seen.body).toMatchObject({ ok: false, code: "note_not_found" });
    expect(m.openFile).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", {}],
    ["non-string", { path: 7 }],
    ["empty", { path: "" }],
    ["absolute posix", { path: "/etc/passwd" }],
    ["absolute windows", { path: "C:\\Windows\\win.ini" }],
    ["backslash root", { path: "\\\\host\\share" }],
    ["traversal", { path: "../outside.md" }],
    ["embedded traversal", { path: "a/../../outside.md" }],
    ["backslash traversal", { path: "a\\..\\..\\outside.md" }],
    ["NUL byte", { path: "a\u0000b.md" }],
    ["a URI", { path: "obsidian://open?vault=x&file=y" }],
  ])("rejects a %s path as invalid_input before any vault lookup", async (_l, body) => {
    const m = makeApp({
      "obsidian://open?vault=x&file=y": tfile("obsidian://open?vault=x&file=y"),
    });
    const { res, seen } = makeRes();
    await handler(m.app)({ body }, res);
    expect(seen.body).toMatchObject({ ok: false, code: "invalid_input" });
    expect(m.lookups).toEqual([]);
    expect(m.openFile).not.toHaveBeenCalled();
  });
});
