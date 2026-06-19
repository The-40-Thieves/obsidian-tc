import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { makeM3Vault } from "./m3-helpers";

function hashOf(r: ToolResult): string {
  if (r.ok) throw new Error("expected an error result");
  return String((r.error.details as { args_hash?: string }).args_hash);
}
function mint(v: ReturnType<typeof makeM3Vault>, toolName: string, argsHash: string): string {
  return issueElicitToken(v.db, { vaultId: v.id, toolName, argsHash, caller: "test" });
}

describe("Domain 9: Attachments", () => {
  it("list_attachments returns ext-filtered files with MIME and optional ref counts", async () => {
    const v = makeM3Vault({
      files: {
        "a.png": "x",
        "b.pdf": "y",
        "sub/c.jpg": "z",
        "note.md": "# not an attachment",
        "ref.md": "embed ![[a.png]]\n",
      },
    });
    try {
      const r = await v.call("list_attachments", { vault: "test", include_reference_count: true });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as {
          total_returned: number;
          attachments: Array<{ path: string; mime: string; reference_count?: number }>;
        };
        expect(d.total_returned).toBe(3);
        expect(d.attachments.map((a) => a.path).sort()).toEqual(["a.png", "b.pdf", "sub/c.jpg"]);
        const png = d.attachments.find((a) => a.path === "a.png");
        expect(png?.mime).toBe("image/png");
        expect(png?.reference_count).toBe(1);
      }
    } finally {
      v.cleanup();
    }
  });

  it("get_attachment returns base64 bytes that round-trip, plus MIME and size", async () => {
    const v = makeM3Vault({ files: { "a.png": "PNGDATA" } });
    try {
      const r = await v.call("get_attachment", { vault: "test", path: "a.png" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { mime: string; size: number; encoding: string; content: string };
        expect(d.mime).toBe("image/png");
        expect(d.size).toBe(7);
        expect(d.encoding).toBe("base64");
        expect(Buffer.from(d.content, "base64").toString("utf8")).toBe("PNGDATA");
      }
    } finally {
      v.cleanup();
    }
  });

  it("get_attachment enforces max_bytes and reports missing files", async () => {
    const v = makeM3Vault({ files: { "big.png": "PNGDATA" } });
    try {
      const over = await v.call("get_attachment", { vault: "test", path: "big.png", max_bytes: 3 });
      expect(over.ok).toBe(false);
      if (!over.ok) expect(over.error.code).toBe("invalid_input");
      const missing = await v.call("get_attachment", { vault: "test", path: "ghost.png" });
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.error.code).toBe("note_not_found");
    } finally {
      v.cleanup();
    }
  });

  it("move_attachment renames within a folder and repoints links without confirmation", async () => {
    const v = makeM3Vault({ files: { "img.png": "x", "n.md": "see ![](img.png)\n" } });
    try {
      const r = await v.call("move_attachment", {
        vault: "test",
        from: "img.png",
        to: "image.png",
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { references_updated: { notes: number; refs: number } };
        expect(d.references_updated).toEqual({ notes: 1, refs: 1 });
      }
      expect(v.exists("image.png")).toBe(true);
      expect(v.exists("img.png")).toBe(false);
      expect(v.read("n.md")).toContain("![](image.png)");
    } finally {
      v.cleanup();
    }
  });

  it("move_attachment across a folder boundary runs the HITL cycle", async () => {
    const v = makeM3Vault({ files: { "old/img.png": "x", "n.md": "see [d](old/img.png)\n" } });
    try {
      const input = { vault: "test", from: "old/img.png", to: "new/img.png" };
      const need = await v.call("move_attachment", input);
      expect(need.ok).toBe(false);
      if (!need.ok) expect(need.error.code).toBe("elicit_required");
      const ok = await v.call("move_attachment", input, {
        elicitToken: mint(v, "move_attachment", hashOf(need)),
      });
      expect(ok.ok).toBe(true);
      expect(v.exists("new/img.png")).toBe(true);
      expect(v.exists("old/img.png")).toBe(false);
      expect(v.read("n.md")).toContain("[d](new/img.png)");
    } finally {
      v.cleanup();
    }
  });

  it("delete_attachment is destructive: gates on HITL, trashes, and reports references", async () => {
    const v = makeM3Vault({ files: { "img.png": "x", "n.md": "![[img.png]]\n" } });
    try {
      const need = await v.call("delete_attachment", { vault: "test", path: "img.png" });
      expect(need.ok).toBe(false);
      if (!need.ok) expect(need.error.code).toBe("elicit_required");
      const ok = await v.call(
        "delete_attachment",
        { vault: "test", path: "img.png" },
        { elicitToken: mint(v, "delete_attachment", hashOf(need)) },
      );
      expect(ok.ok).toBe(true);
      if (ok.ok) {
        const d = ok.data as { trashed_to: string; references: string[] };
        expect(d.trashed_to).toBe(".trash/img.png");
        expect(d.references).toContain("n.md");
      }
      expect(v.exists("img.png")).toBe(false);
      expect(v.exists(".trash/img.png")).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("a move whose destination is outside the write whitelist is acl_denied", async () => {
    const v = makeM3Vault({ files: { "img.png": "x" }, acl: { writePaths: ["assets/**"] } });
    try {
      const denied = await v.call("move_attachment", {
        vault: "test",
        from: "img.png",
        to: "image.png",
      });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe("acl_denied");
    } finally {
      v.cleanup();
    }
  });
});
