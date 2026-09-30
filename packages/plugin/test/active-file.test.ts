// GET /files/active — the companion side of the server's *_active_file tools. It reports which
// vault file the live Obsidian session has active and NOTHING else: no content, no mutation, no
// query parameter (the route is reachable by anyone holding the LRA key, so it takes no input at
// all). A session with nothing open answers { path: null } rather than an error, so the server can
// tell "no active file" apart from "the bridge is broken".
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

const tfile = (path: string, extension: string): TFile =>
  Object.assign(new TFile(), { path, basename: "x", extension });

const handler = (app: InternalApp) => {
  const d = buildFilesRoutes(app).find((r) => r.path === "/files/active");
  if (!d) throw new Error("no /files/active route");
  return d;
};

const appWith = (active: TFile | null) => {
  const getActiveFile = vi.fn(() => active);
  return { app: { workspace: { getActiveFile } } as unknown as InternalApp, getActiveFile };
};

describe("GET /files/active", () => {
  it("is a GET route at /files/active", () => {
    const { app } = appWith(null);
    const d = handler(app);
    expect(`${d.method} ${d.path}`).toBe("get /files/active");
  });

  it("returns the vault-relative path and extension of the active file", async () => {
    const { app, getActiveFile } = appWith(tfile("Notes/a b.md", "md"));
    const { res, seen } = makeRes();
    await handler(app).handler({}, res);
    expect(seen.body).toEqual({ ok: true, result: { path: "Notes/a b.md", extension: "md" } });
    expect(getActiveFile).toHaveBeenCalledTimes(1);
    expect(seen.calls).toBe(1);
  });

  it("reports a non-markdown active file as such (canvas, pdf) rather than hiding it", async () => {
    const { app } = appWith(tfile("Boards/plan.canvas", "canvas"));
    const { res, seen } = makeRes();
    await handler(app).handler({}, res);
    expect(seen.body).toEqual({
      ok: true,
      result: { path: "Boards/plan.canvas", extension: "canvas" },
    });
  });

  it("answers { path: null } (ok, not an error) when nothing is open", async () => {
    const { app } = appWith(null);
    const { res, seen } = makeRes();
    await handler(app).handler({}, res);
    expect(seen.body).toEqual({ ok: true, result: { path: null, extension: null } });
  });

  it("ignores any query or body a caller sends: it takes no input", async () => {
    const { app, getActiveFile } = appWith(tfile("a.md", "md"));
    const { res, seen } = makeRes();
    await handler(app).handler(
      { query: { path: "../../etc/passwd" }, body: { path: "x.md" } },
      res,
    );
    expect(seen.body).toEqual({ ok: true, result: { path: "a.md", extension: "md" } });
    expect(getActiveFile).toHaveBeenCalledTimes(1);
  });
});
