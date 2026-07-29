// THE-602 second wave: genuine-behavior tests closing uncovered branches in
// src/tools/m3/attachment-tools.ts (folder-scoped listing + pagination, the
// isAttachment/folder-type guards, include_references, move's same-path/missing-source/
// destination-is-a-folder/create_dirs/update_references branches, and delete's
// missing-file and permanent-delete branches). Complements test/attachments.test.ts,
// which does not exercise these paths.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import type { CallerContext } from "../src/mcp/registry";
import { ToolRegistry } from "../src/mcp/registry";
import { registerM3Tools } from "../src/tools/m3";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { makeM3Vault } from "./m3-helpers";

describe("attachment-tools branch coverage", () => {
  it("list_attachments scoped to a folder enforces read ACL on that folder and filters entries", async () => {
    const v = makeM3Vault({
      files: { "sub/a.png": "x", "other/b.png": "y", "root.png": "z" },
    });
    try {
      const r = await v.call("list_attachments", { vault: "test", folder: "sub" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { folder: string; attachments: Array<{ path: string }> };
        expect(d.folder).toBe("sub");
        expect(d.attachments.map((a) => a.path)).toEqual(["sub/a.png"]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("a folder-scoped list outside the read whitelist is acl_denied", async () => {
    const v = makeM3Vault({
      files: { "sub/a.png": "x" },
      acl: { readPaths: ["allowed/**"] },
    });
    try {
      const r = await v.call("list_attachments", { vault: "test", folder: "sub" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("acl_denied");
    } finally {
      v.cleanup();
    }
  });

  it("list_attachments paginates with a cursor when results exceed the limit", async () => {
    const v = makeM3Vault({ files: { "a.png": "1", "b.png": "2", "c.png": "3" } });
    try {
      const first = await v.call("list_attachments", { vault: "test", limit: 1 });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const d1 = first.data as { attachments: Array<{ path: string }>; next_cursor: string | null };
      expect(d1.attachments.map((a) => a.path)).toEqual(["a.png"]);
      expect(d1.next_cursor).toBe("a.png");

      const second = await v.call("list_attachments", {
        vault: "test",
        limit: 1,
        cursor: d1.next_cursor as string,
      });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      const d2 = second.data as {
        attachments: Array<{ path: string }>;
        next_cursor: string | null;
      };
      expect(d2.attachments.map((a) => a.path)).toEqual(["b.png"]);
      expect(d2.next_cursor).toBe("b.png");

      const third = await v.call("list_attachments", {
        vault: "test",
        limit: 10,
        cursor: d2.next_cursor as string,
      });
      expect(third.ok).toBe(true);
      if (third.ok) {
        const d3 = third.data as {
          attachments: Array<{ path: string }>;
          next_cursor: string | null;
        };
        expect(d3.attachments.map((a) => a.path)).toEqual(["c.png"]);
        expect(d3.next_cursor).toBeNull();
      }
    } finally {
      v.cleanup();
    }
  });

  it("get_attachment rejects a path whose extension is not an attachment", async () => {
    const v = makeM3Vault({ files: { "note.md": "# hi" } });
    try {
      const r = await v.call("get_attachment", { vault: "test", path: "note.md" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });

  it("get_attachment on a directory with an attachment-like name reports note_not_found", async () => {
    const v = makeM3Vault({ files: { "a.png": "x" } });
    try {
      mkdirSync(join(v.root, "dir.png"));
      const r = await v.call("get_attachment", { vault: "test", path: "dir.png" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("note_not_found");
    } finally {
      v.cleanup();
    }
  });

  it("get_attachment with include_references reports the referencing notes", async () => {
    const v = makeM3Vault({ files: { "a.png": "x", "n.md": "![[a.png]]\n" } });
    try {
      const r = await v.call("get_attachment", {
        vault: "test",
        path: "a.png",
        include_references: true,
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.data as { references: string[] }).references).toEqual(["n.md"]);
    } finally {
      v.cleanup();
    }
  });

  it("move_attachment refuses when from and to are identical", async () => {
    const v = makeM3Vault({ files: { "a.png": "x" } });
    try {
      const r = await v.call("move_attachment", { vault: "test", from: "a.png", to: "a.png" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
      expect(v.exists("a.png")).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("move_attachment reports note_not_found for a missing source", async () => {
    const v = makeM3Vault({});
    try {
      const r = await v.call("move_attachment", { vault: "test", from: "ghost.png", to: "b.png" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("note_not_found");
    } finally {
      v.cleanup();
    }
  });

  it("move_attachment reports note_not_found when the source is actually a directory", async () => {
    const v = makeM3Vault({ files: { "keep.png": "x" } });
    try {
      mkdirSync(join(v.root, "dir.png"));
      const r = await v.call("move_attachment", { vault: "test", from: "dir.png", to: "b.png" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("note_not_found");
    } finally {
      v.cleanup();
    }
  });

  it("move_attachment refuses when the destination is an existing folder", async () => {
    const v = makeM3Vault({ files: { "a.png": "x" } });
    try {
      mkdirSync(join(v.root, "adir"));
      const r = await v.call("move_attachment", { vault: "test", from: "a.png", to: "adir" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
      expect(v.exists("a.png")).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("move_attachment with update_references:false leaves note links untouched", async () => {
    const v = makeM3Vault({ files: { "img.png": "x", "n.md": "see ![](img.png)\n" } });
    try {
      const r = await v.call("move_attachment", {
        vault: "test",
        from: "img.png",
        to: "image.png",
        update_references: false,
      });
      expect(r.ok).toBe(true);
      if (r.ok)
        expect(
          (r.data as { references_updated: { notes: number; refs: number } }).references_updated,
        ).toEqual({
          notes: 0,
          refs: 0,
        });
      expect(v.exists("image.png")).toBe(true);
      // link was never rewritten, so it now dangles on the old name
      expect(v.read("n.md")).toContain("![](img.png)");
    } finally {
      v.cleanup();
    }
  });

  it("move_attachment with create_dirs:false succeeds when the destination folder already exists", async () => {
    const v = makeM3Vault({ files: { "a.png": "x" } });
    try {
      const r = await v.call("move_attachment", {
        vault: "test",
        from: "a.png",
        to: "b.png",
        options: { create_dirs: false },
      });
      expect(r.ok).toBe(true);
      expect(v.exists("b.png")).toBe(true);
      expect(v.exists("a.png")).toBe(false);
    } finally {
      v.cleanup();
    }
  });

  it("delete_attachment reports note_not_found for a missing file", async () => {
    const v = makeM3Vault({});
    try {
      const r = await v.callConfirmed("delete_attachment", { vault: "test", path: "ghost.png" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("note_not_found");
    } finally {
      v.cleanup();
    }
  });

  it("delete_attachment reports note_not_found when the path is actually a directory", async () => {
    const v = makeM3Vault({});
    try {
      mkdirSync(join(v.root, "dir.png"));
      const r = await v.callConfirmed("delete_attachment", { vault: "test", path: "dir.png" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("note_not_found");
    } finally {
      v.cleanup();
    }
  });

  it("delete_attachment with permanent:true removes the file instead of trashing it", async () => {
    const v = makeM3Vault({ files: { "img.png": "x" } });
    try {
      const r = await v.callConfirmed("delete_attachment", {
        vault: "test",
        path: "img.png",
        permanent: true,
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { permanent: boolean; trashed_to: string | null };
        expect(d.permanent).toBe(true);
        expect(d.trashed_to).toBeNull();
      }
      expect(v.exists("img.png")).toBe(false);
      expect(v.exists(".trash/img.png")).toBe(false);
    } finally {
      v.cleanup();
    }
  });
});

describe("attachment-tools branch coverage: reference discovery is ACL-filtered (THE-607)", () => {
  // findAttachmentReferences (src/formats/attachments.ts) walks the WHOLE vault and reads every
  // note's content with NO per-note ACL check. get_attachment/delete_attachment/list_attachments
  // are safe to expose it only because every call site filters the result through
  // readableRel(ctx.acl, p) before it reaches the caller (see the N-2 comment on get_attachment,
  // and the CROSS_NOTE_READ_TOOLS carve-out in src/vault/acl-audit.ts, which is conditional on
  // these three tests staying green). "out/note.md" sits outside the read whitelist below; if any
  // of the `.filter((p) => readableRel(ctx.acl, p))` calls were ever dropped, its path would leak
  // into the response and these tests would go red.
  function vaultWithHiddenReferrer() {
    return makeM3Vault({
      files: {
        "a.png": "x",
        "in/note.md": "![[a.png]]\n",
        "out/note.md": "![[a.png]]\n",
      },
      acl: { readPaths: ["a.png", "in/**"] }, // "out/**" is NOT in the read whitelist
    });
  }

  it("get_attachment's include_references omits a referencing note outside the read ACL", async () => {
    const v = vaultWithHiddenReferrer();
    try {
      const r = await v.call("get_attachment", {
        vault: "test",
        path: "a.png",
        include_references: true,
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const refs = (r.data as { references: string[] }).references;
        expect(refs).toEqual(["in/note.md"]);
        expect(refs).not.toContain("out/note.md");
      }
    } finally {
      v.cleanup();
    }
  });

  it("delete_attachment's references list omits a referencing note outside the read ACL", async () => {
    const v = vaultWithHiddenReferrer();
    try {
      const r = await v.callConfirmed("delete_attachment", { vault: "test", path: "a.png" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const refs = (r.data as { references: string[] }).references;
        expect(refs).toEqual(["in/note.md"]);
        expect(refs).not.toContain("out/note.md");
      }
    } finally {
      v.cleanup();
    }
  });

  it("list_attachments's include_reference_count excludes a referencing note outside the read ACL", async () => {
    const v = vaultWithHiddenReferrer();
    try {
      const r = await v.call("list_attachments", { vault: "test", include_reference_count: true });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const entry = (
          r.data as { attachments: Array<{ path: string; reference_count?: number }> }
        ).attachments.find((a) => a.path === "a.png");
        // 1, not 2: "out/note.md" also links to a.png but must not be counted.
        expect(entry?.reference_count).toBe(1);
      }
    } finally {
      v.cleanup();
    }
  });
});

describe("attachment-tools branch coverage: list_attachments's pathAcl extractor (both legs)", () => {
  // def.pathAcl is only invoked by runDispatch's central folder-ACL stage when a rootResolver is
  // wired (registry.ts: `const root = this.rootResolver?.(effVault); if (root) { ... def.pathAcl(...) }`).
  // makeM3Vault's harness never wires one, so both legs of
  // `input.folder ? [{ op: "read", path: input.folder }] : []` on attachment-tools.ts:145 need a
  // registry built with rootResolver — same pattern as the periodic-tools THE-602 suite.
  function setup() {
    const root = mkdtempSync(join(tmpdir(), "obtc-602-attach-pathacl-"));
    const db = openMemoryDb();
    provisionCacheDb(db);
    const acl = new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] });
    const vaultRegistry = new VaultRegistry([{ id: "test", path: root }]);
    const registry = new ToolRegistry({ rootResolver: () => root });
    registerM3Tools(registry, { vaultRegistry });
    const ctx: CallerContext = {
      caller: "t",
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: "test",
      db,
      acl,
    };
    return { root, registry, ctx };
  }

  it("declares a read op on the folder when present, gating the central ACL stage", async () => {
    const { root, registry, ctx } = setup();
    try {
      mkdirSync(join(root, "sub"), { recursive: true });
      writeFileSync(join(root, "sub", "a.png"), "x");
      writeFileSync(join(root, "root.png"), "y");
      const r = await registry.dispatch("list_attachments", { vault: "test", folder: "sub" }, ctx);
      expect(r.ok).toBe(true);
      if (r.ok)
        expect(
          (r.data as { attachments: Array<{ path: string }> }).attachments.map((a) => a.path),
        ).toEqual(["sub/a.png"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("declares no path ops when folder is absent", async () => {
    const { root, registry, ctx } = setup();
    try {
      writeFileSync(join(root, "root.png"), "y");
      const r = await registry.dispatch("list_attachments", { vault: "test" }, ctx);
      expect(r.ok).toBe(true);
      if (r.ok)
        expect(
          (r.data as { attachments: Array<{ path: string }> }).attachments.map((a) => a.path),
        ).toEqual(["root.png"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
