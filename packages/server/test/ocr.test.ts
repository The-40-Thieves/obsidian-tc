// Domain 15 — OCR / Text Extractor. Both tools are read-side bridge proxies (plugin
// id "text-extractor"). ocr_attachment guards existence + ACL server-side; ocr_bulk
// resolves and ACL-filters its candidate set server-side and HITL-gates past 20 files.
import { afterEach, describe, expect, it } from "vitest";
import { type M4Vault, makeM4Vault } from "./m4-helpers";

const ATT = "Attach/scan.png";

describe("ocr_attachment", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  const routes = {
    "POST /obsidian-tc/v1/ocr/attachment": {
      body: { ok: true, result: { text: "hello world", cached: false, duration_ms: 12 } },
    },
  };

  it("OCRs an existing attachment via the bridge", async () => {
    v = makeM4Vault({ installed: ["text-extractor"], files: { [ATT]: "binary" }, routes });
    const res = await v.call("ocr_attachment", { vault: "test", path: ATT });
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as Record<string, unknown>).text).toBe("hello world");
    const req = v.bridgeRequests[0];
    if (!req) throw new Error("expected a bridge request");
    const body = JSON.parse(req.body ?? "{}") as Record<string, unknown>;
    expect(body.path).toBe(ATT);
    expect(body.force).toBe(false);
  });

  it("reports note_not_found before any bridge call when the file is missing", async () => {
    v = makeM4Vault({ installed: ["text-extractor"], routes });
    const res = await v.call("ocr_attachment", { vault: "test", path: ATT });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("note_not_found");
    expect(v.bridgeRequests).toHaveLength(0);
  });

  it("enforces the read ACL", async () => {
    v = makeM4Vault({
      installed: ["text-extractor"],
      files: { [ATT]: "binary" },
      acl: { readPaths: ["Allowed/**"] },
    });
    const res = await v.call("ocr_attachment", { vault: "test", path: ATT });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("acl_denied");
  });

  it("degrades to plugin_missing when Text Extractor is absent", async () => {
    v = makeM4Vault({ installed: [], files: { [ATT]: "binary" } });
    const res = await v.call("ocr_attachment", { vault: "test", path: ATT });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("plugin_missing");
  });
});

describe("ocr_bulk", () => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  const routes = {
    "POST /obsidian-tc/v1/ocr/bulk": {
      body: { ok: true, result: { processed: 1, results: [{ path: "a.png", ok: true }] } },
    },
  };

  it("requires confirmation even for a small batch (always a bulk HITL floor)", async () => {
    v = makeM4Vault({ installed: ["text-extractor"], routes });
    const input = { vault: "test", paths: ["Attach/a.png"] };

    const denied = await v.call("ocr_bulk", input);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("elicit_required");
    expect(v.bridgeRequests).toHaveLength(0);

    const ok = await v.callConfirmed("ocr_bulk", input);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect((ok.data as Record<string, unknown>).requested).toBe(1);
    // the bulk HITL floor consumed the single-use confirmation token
    const tok = v.db
      .prepare("SELECT consumed_at FROM elicit_tokens ORDER BY rowid DESC LIMIT 1")
      .get() as { consumed_at: number | null } | undefined;
    expect(tok?.consumed_at).not.toBeNull();
    const req = v.bridgeRequests[0];
    if (!req) throw new Error("expected a bridge request");
    expect((JSON.parse(req.body ?? "{}") as Record<string, unknown>).paths).toEqual([
      "Attach/a.png",
    ]);
  });

  it("requires confirmation past 20 files, then runs once confirmed", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => [`Attach/i${i}.png`, "x"]),
    );
    v = makeM4Vault({ installed: ["text-extractor"], files, routes });
    const input = { vault: "test", root: "Attach" };

    const denied = await v.call("ocr_bulk", input);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("elicit_required");
    expect(v.bridgeRequests).toHaveLength(0);

    const ok = await v.callConfirmed("ocr_bulk", input);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect((ok.data as Record<string, unknown>).requested).toBe(21);
  });
});
