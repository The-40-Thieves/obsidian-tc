// `conventions.protectSchemaFiles`: with it on, every operation that creates, edits, deletes, moves
// or renames a file named SCHEMA.md needs the admin scope. Reads are unchanged: a caller who cannot
// write a layer is still held to its rules and still sees it in get_conventions.
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAdminTools } from "../src/tools/m6/admin-tools";
import { WIKI_SCHEMA_FILE } from "../src/tools/m7/knowledge/wiki-schema";
import { SCHEMA_LAYER_NAME } from "../src/vault/acl-path";
import { CHECKED, confirmedCall, STATUS_RULES, withVault } from "./conventions-helpers";
import { makeM6Vault } from "./m6-helpers";

const WRITER = new Set(["read:*", "write:*", "delete:*"]);
const ADMIN = new Set(["read:*", "write:*", "delete:*", "admin:*"]);
const PROTECTED = {
  ...CHECKED,
  protectSchemaFiles: true,
  acl: { writePaths: ["F/**"], deletePaths: ["F/**"] },
};
const LAYER = "---\ntype: layer\n---\n# rules\n";

/** The denial's code and details, or undefined when the call succeeded. */
function denial(r: { ok: boolean; error?: { code: string; details?: unknown } }) {
  return r.ok ? undefined : r.error;
}

describe("conventions.protectSchemaFiles", () => {
  it("the protected layer name is the one the layer loader uses", () => {
    expect(SCHEMA_LAYER_NAME).toBe(WIKI_SCHEMA_FILE);
  });

  it("write_note creating F/SCHEMA.md is acl_denied for a writer without admin", async () => {
    await withVault({ ...PROTECTED, files: { "F/a.md": "x\n" } }, async (v) => {
      const r = await v.call(
        "write_note",
        { vault: "test", path: "F/SCHEMA.md", content: LAYER },
        { grantedScopes: WRITER },
      );
      expect(denial(r)?.code).toBe("acl_denied");
      expect(denial(r)?.details).toMatchObject({ path: "F/SCHEMA.md", op: "write" });
      expect(v.exists("F/SCHEMA.md")).toBe(false);
    });
  });

  it("write_note overwriting an existing F/SCHEMA.md is acl_denied", async () => {
    await withVault({ ...PROTECTED, files: { "F/SCHEMA.md": LAYER } }, async (v) => {
      const r = await confirmedCall(
        v,
        "write_note",
        { vault: "test", path: "F/SCHEMA.md", content: "# gone\n", mode: "overwrite" },
        { grantedScopes: WRITER },
      );
      expect(denial(r)?.code).toBe("acl_denied");
      expect(v.read("F/SCHEMA.md")).toBe(LAYER);
    });
  });

  it("append_note and update_frontmatter on F/SCHEMA.md are acl_denied", async () => {
    await withVault({ ...PROTECTED, files: { "F/SCHEMA.md": LAYER } }, async (v) => {
      const a = await v.call(
        "append_note",
        { vault: "test", path: "F/SCHEMA.md", content: "more\n" },
        { grantedScopes: WRITER },
      );
      const u = await v.call(
        "update_frontmatter",
        { vault: "test", path: "F/SCHEMA.md", operation: "set", key: "type", value: "x" },
        { grantedScopes: WRITER },
      );
      expect(denial(a)?.code).toBe("acl_denied");
      expect(denial(u)?.code).toBe("acl_denied");
      expect(v.read("F/SCHEMA.md")).toBe(LAYER);
    });
  });

  it("delete_note on F/SCHEMA.md is acl_denied", async () => {
    await withVault({ ...PROTECTED, files: { "F/SCHEMA.md": LAYER } }, async (v) => {
      const r = await confirmedCall(
        v,
        "delete_note",
        { vault: "test", path: "F/SCHEMA.md" },
        { grantedScopes: WRITER },
      );
      expect(denial(r)?.code).toBe("acl_denied");
      expect(v.read("F/SCHEMA.md")).toBe(LAYER);
    });
  });

  it("move_note with SCHEMA.md as source or as destination is acl_denied", async () => {
    await withVault(
      { ...PROTECTED, files: { "F/SCHEMA.md": LAYER, "F/n.md": "n\n" } },
      async (v) => {
        const out = await confirmedCall(
          v,
          "move_note",
          { vault: "test", from: "F/SCHEMA.md", to: "F/moved.md" },
          { grantedScopes: WRITER },
        );
        const into = await confirmedCall(
          v,
          "move_note",
          { vault: "test", from: "F/n.md", to: "F/SCHEMA.md" },
          { grantedScopes: WRITER },
        );
        expect(denial(out)?.code).toBe("acl_denied");
        expect(denial(into)?.code).toBe("acl_denied");
        expect(v.read("F/SCHEMA.md")).toBe(LAYER);
        expect(v.read("F/n.md")).toBe("n\n");
      },
    );
  });

  it("copy_note with SCHEMA.md as destination is acl_denied", async () => {
    await withVault({ ...PROTECTED, files: { "F/n.md": "n\n" } }, async (v) => {
      const r = await v.call(
        "copy_note",
        { vault: "test", from: "F/n.md", to: "F/SCHEMA.md" },
        { grantedScopes: WRITER },
      );
      expect(denial(r)?.code).toBe("acl_denied");
      expect(v.exists("F/SCHEMA.md")).toBe(false);
    });
  });

  it("the root SCHEMA.md and a dotted spelling of it are acl_denied", async () => {
    const open = {
      ...CHECKED,
      protectSchemaFiles: true,
      acl: { writePaths: ["**"], deletePaths: ["**"] },
    };
    await withVault({ ...open, files: { "SCHEMA.md": LAYER } }, async (v) => {
      const root = await confirmedCall(
        v,
        "write_note",
        { vault: "test", path: "SCHEMA.md", content: "x\n", mode: "overwrite" },
        { grantedScopes: WRITER },
      );
      const dotted = await v.call(
        "write_note",
        { vault: "test", path: "F/./SCHEMA.md", content: "x\n" },
        { grantedScopes: WRITER },
      );
      expect(denial(root)?.code).toBe("acl_denied");
      expect(denial(dotted)?.code).toBe("acl_denied");
      expect(v.read("SCHEMA.md")).toBe(LAYER);
    });
  });

  it.skipIf(process.platform === "win32")(
    "a symlink whose target is SCHEMA.md is acl_denied",
    async () => {
      await withVault(
        {
          ...PROTECTED,
          files: { "F/SCHEMA.md": LAYER },
          setup: (root) => symlinkSync("SCHEMA.md", join(root, "F", "alias.md")),
        },
        async (v) => {
          // A write through a symlink is refused before the ACL (safe open), so the delete is the case
          // that reaches the layer: it removes the link, and the link's real target is SCHEMA.md.
          const r = await confirmedCall(
            v,
            "delete_note",
            { vault: "test", path: "F/alias.md" },
            { grantedScopes: WRITER },
          );
          expect(denial(r)?.code).toBe("acl_denied");
          expect(v.read("F/SCHEMA.md")).toBe(LAYER);
        },
      );
    },
  );

  it("the same writer still writes F/note.md, is held to the layer's block rule, and sees the layer", async () => {
    const files = { "F/SCHEMA.md": STATUS_RULES("block") };
    await withVault({ ...PROTECTED, files }, async (v) => {
      const bare = await v.call(
        "write_note",
        { vault: "test", path: "F/note.md", content: "x\n" },
        { grantedScopes: WRITER },
      );
      expect(denial(bare)?.code).not.toBe("acl_denied");
      expect(bare.ok).toBe(false);
      const ok = await v.call(
        "write_note",
        { vault: "test", path: "F/ok.md", content: "---\ntype: a\nstatus: draft\n---\nbody\n" },
        { grantedScopes: WRITER },
      );
      expect(ok.ok).toBe(true);
      const conv = await v.call(
        "get_conventions",
        { vault: "test", path: "F/note.md" },
        { grantedScopes: WRITER },
      );
      expect(conv.ok).toBe(true);
      expect(JSON.stringify(conv.ok ? conv.data : null)).toContain("F/SCHEMA.md");
    });
  });

  it("an admin caller can edit F/SCHEMA.md", async () => {
    await withVault({ ...PROTECTED, files: { "F/SCHEMA.md": LAYER } }, async (v) => {
      const r = await v.call(
        "append_note",
        { vault: "test", path: "F/SCHEMA.md", content: "more\n" },
        { grantedScopes: ADMIN },
      );
      expect(r.ok).toBe(true);
      expect(v.read("F/SCHEMA.md")).toContain("more");
    });
  });

  it("with protectSchemaFiles off (the default) the writer can write F/SCHEMA.md", async () => {
    await withVault(
      { ...CHECKED, acl: { writePaths: ["F/**"] }, files: { "F/SCHEMA.md": LAYER } },
      async (v) => {
        const r = await v.call(
          "append_note",
          { vault: "test", path: "F/SCHEMA.md", content: "more\n" },
          { grantedScopes: WRITER },
        );
        expect(r.ok).toBe(true);
      },
    );
  });

  it("inspect_acl reports the schema-file denial for the writer and allows the admin", async () => {
    // inspect_acl lives in the M6 admin tools, so this vault is the M6 helper's, not the M1 one.
    const v = makeM6Vault({
      acl: { protectSchemaFiles: true, writePaths: ["F/**"] },
      files: { "F/SCHEMA.md": LAYER },
      register: (r, d) => {
        for (const t of buildAdminTools(d)) r.register(t);
      },
    });
    try {
      const inspect = (scopes: string[]) =>
        v.call("inspect_acl", { vault: "test", path: "F/SCHEMA.md", op: "write", scopes });
      const writer = await inspect(["write:*"]);
      const admin = await inspect(["write:*", "admin:*"]);
      expect(writer).toMatchObject({
        ok: true,
        data: { allowed: false, denied_by: "schema_file" },
      });
      expect(admin).toMatchObject({ ok: true, data: { allowed: true } });
    } finally {
      v.cleanup();
    }
  });
});
