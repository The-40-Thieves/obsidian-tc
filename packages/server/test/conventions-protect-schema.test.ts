// `conventions.protectSchemaFiles`: with it on, every operation that creates, edits, deletes, moves
// or renames a file named SCHEMA.md needs the admin:conventions scope. Reads are unchanged: a caller
// who cannot write a layer is still held to its rules and still sees it in get_conventions.
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CASE_INSENSITIVE_FS } from "../src/acl";
import { registerM3Tools } from "../src/tools/m3";
import { buildAdminTools } from "../src/tools/m6/admin-tools";
import { buildBulkTools } from "../src/tools/m6/bulk-tools";
import { WIKI_SCHEMA_FILE } from "../src/tools/m7/knowledge/wiki-schema";
import { SCHEMA_LAYER_NAME } from "../src/vault/acl-path";
import { CHECKED, confirmedCall, STATUS_RULES, withVault } from "./conventions-helpers";
import { makeM6Vault } from "./m6-helpers";
import { makeTempDir, rmTemp } from "./tmp";
import { makeWikiHarness } from "./wiki-test-helpers";

const WRITER = new Set(["read:*", "write:*", "delete:*"]);
const ADMIN = new Set(["read:*", "write:*", "delete:*", "admin:conventions"]);
const PROTECTED = {
  ...CHECKED,
  protectSchemaFiles: true,
  acl: { writePaths: ["F/**"], deletePaths: ["F/**"] },
};
const LAYER = "---\ntype: layer\n---\n# rules\n";

/** The bulk tools next to the M3 set, for the bulk_* cases below. */
const registerBulk = (
  r: Parameters<typeof registerM3Tools>[0],
  vaultRegistry: Parameters<typeof registerM3Tools>[1]["vaultRegistry"],
): void => {
  registerM3Tools(r, { vaultRegistry } as never);
  for (const t of buildBulkTools({
    vaultRegistry,
    throttle: { maxConcurrentWritesPerVault: 4 },
  } as never))
    r.register(t);
};

/** The denial's code and details, or undefined when the call succeeded. */
function denial(r: { ok: boolean; error?: { code: string; details?: unknown } }) {
  return r.ok ? undefined : r.error;
}

/** A refusal by the schema-file check: acl_denied, with the reason the check names. */
const SCHEMA_REFUSAL = { code: "acl_denied", details: { reason: "schema_file" } };

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
});

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
      expect(denial(r)).toMatchObject({
        ...SCHEMA_REFUSAL,
        details: { path: "F/SCHEMA.md", op: "write", reason: "schema_file" },
      });
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
      expect(denial(r)).toMatchObject(SCHEMA_REFUSAL);
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
      expect(denial(a)).toMatchObject(SCHEMA_REFUSAL);
      expect(denial(u)).toMatchObject(SCHEMA_REFUSAL);
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
      expect(denial(r)).toMatchObject(SCHEMA_REFUSAL);
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
        expect(denial(out)).toMatchObject(SCHEMA_REFUSAL);
        expect(denial(into)).toMatchObject(SCHEMA_REFUSAL);
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
      expect(denial(r)).toMatchObject(SCHEMA_REFUSAL);
      expect(v.exists("F/SCHEMA.md")).toBe(false);
    });
  });

  it("bulk_create_notes, bulk_set_property and patch_note refuse a SCHEMA.md", async () => {
    const BULK = new Set([...WRITER, "bulk:*"]);
    await withVault(
      {
        ...PROTECTED,
        files: { "F/SCHEMA.md": STATUS_RULES("block"), "F/n.md": "n\n" },
        registerTools: registerBulk,
      },
      async (v) => {
        const create = await confirmedCall(
          v,
          "bulk_create_notes",
          { vault: "test", items: [{ path: "F/sub/SCHEMA.md", content: "---\ntype: x\n---\n" }] },
          { grantedScopes: BULK },
        );
        const prop = await confirmedCall(
          v,
          "bulk_set_property",
          { vault: "test", paths: ["F/SCHEMA.md"], key: "type", value: "x" },
          { grantedScopes: BULK },
        );
        const patch = await v.call(
          "patch_note",
          {
            vault: "test",
            path: "F/SCHEMA.md",
            operation: "replace_text",
            old_string: "block",
            new_string: "warn",
          },
          { grantedScopes: WRITER },
        );
        expect(denial(create)).toMatchObject(SCHEMA_REFUSAL);
        expect(denial(prop)).toMatchObject(SCHEMA_REFUSAL);
        expect(denial(patch)).toMatchObject(SCHEMA_REFUSAL);
        expect(v.exists("F/sub/SCHEMA.md")).toBe(false);
        expect(v.read("F/SCHEMA.md")).toBe(STATUS_RULES("block"));
      },
    );
  });

  it("bulk_move_notes refuses SCHEMA.md as the source and as the destination", async () => {
    const BULK = new Set([...WRITER, "bulk:*"]);
    await withVault(
      {
        ...PROTECTED,
        acl: { writePaths: ["F/**"], deletePaths: ["F/**"] },
        files: { "F/SCHEMA.md": LAYER, "F/n.md": "n\n" },
        registerTools: registerBulk,
      },
      async (v) => {
        const src = await confirmedCall(
          v,
          "bulk_move_notes",
          { vault: "test", moves: [{ from: "F/SCHEMA.md", to: "F/x.md" }], dry_run: false },
          { grantedScopes: BULK },
        );
        const dst = await confirmedCall(
          v,
          "bulk_move_notes",
          { vault: "test", moves: [{ from: "F/n.md", to: "F/SCHEMA.md" }], dry_run: false },
          { grantedScopes: BULK },
        );
        expect(denial(src)).toMatchObject(SCHEMA_REFUSAL);
        expect(denial(dst)).toMatchObject(SCHEMA_REFUSAL);
        expect(v.read("F/SCHEMA.md")).toBe(LAYER);
        expect(v.read("F/n.md")).toBe("n\n");
      },
    );
  });

  it("commit_wiki_page targeting wiki/SCHEMA.md leaves the layer as it was", async () => {
    const SCHEMA =
      "---\nconventions:\n  frontmatter:\n    required: [type]\n    severity: { type: block }\n---\n# rules\n\n## Links\n";
    const hh = makeWikiHarness({
      files: { "wiki/SCHEMA.md": SCHEMA, "wiki/a.md": "---\ntype: concept\n---\n# A\n" },
      wikiFolder: "wiki",
      centralAcl: true,
      conventions: true,
      protectSchemaFiles: true,
      acl: { writePaths: ["wiki/**"] },
    });
    try {
      const W = { grantedScopes: new Set(["read:*", "write:*"]) };
      const page = await hh.v.call(
        "commit_wiki_page",
        {
          vault: "test",
          topic: "x",
          type: "concept",
          page: {
            path: "wiki/SCHEMA.md",
            frontmatter: { type: "concept" },
            body: "# x\n",
            mode: "overwrite",
          },
          patches: [],
        },
        W,
      );
      expect(page.ok).toBe(false);
      expect(denial(page)?.code).toBe("acl_denied");
      expect(hh.v.read("wiki/SCHEMA.md")).toBe(SCHEMA);
    } finally {
      hh.v.cleanup();
    }
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
      expect(denial(root)).toMatchObject(SCHEMA_REFUSAL);
      expect(denial(dotted)).toMatchObject(SCHEMA_REFUSAL);
      expect(v.read("SCHEMA.md")).toBe(LAYER);
    });
  });

  it.skipIf(process.platform === "win32")(
    "a directory symlink L -> F is refused when a write names L/SCHEMA.md",
    async () => {
      await withVault(
        {
          ...PROTECTED,
          files: { "F/SCHEMA.md": LAYER, "F/n.md": "n\n" },
          setup: (root) => symlinkSync("F", join(root, "L")),
        },
        async (v) => {
          const r = await confirmedCall(
            v,
            "write_note",
            { vault: "test", path: "L/SCHEMA.md", content: "x\n", mode: "overwrite" },
            { grantedScopes: WRITER },
          );
          expect(denial(r)).toMatchObject(SCHEMA_REFUSAL);
          expect(v.read("F/SCHEMA.md")).toBe(LAYER);
        },
      );
    },
  );

  it.each([
    [["admin:conventions"], true],
    [["admin:*"], true],
    [["admin"], true],
    [["*"], true],
    [["admin:acl"], false],
    [["admin:vault"], false],
  ])("the scopes %j allow the layer write: %s", async (extra, allowed) => {
    await withVault({ ...PROTECTED, files: { "F/SCHEMA.md": LAYER } }, async (v) => {
      const r = await v.call(
        "append_note",
        { vault: "test", path: "F/SCHEMA.md", content: "y\n" },
        { grantedScopes: new Set([...WRITER, ...extra]) },
      );
      expect(r.ok).toBe(allowed);
      if (!allowed) expect(denial(r)).toMatchObject(SCHEMA_REFUSAL);
    });
  });

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

  it("an admin:conventions caller can edit F/SCHEMA.md", async () => {
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

  it("with the flag on in one vault and off in another, only the protected vault refuses", async () => {
    const root2 = makeTempDir("obtc-vault2-");
    cleanups.push(() => rmTemp(root2));
    await withVault(
      {
        ...PROTECTED,
        acl: { writePaths: ["F/**"], deletePaths: ["F/**"] },
        aclByVault: { other: { writePaths: ["F/**"], deletePaths: ["F/**"] } },
        files: { "F/SCHEMA.md": LAYER },
      },
      async (v) => {
        mkdirSync(join(root2, "F"), { recursive: true });
        writeFileSync(join(root2, "F", "SCHEMA.md"), LAYER);
        v.vaultRegistry.register({ id: "other", path: root2 });
        const protectedVault = await v.call(
          "append_note",
          { vault: "test", path: "F/SCHEMA.md", content: "y\n" },
          { grantedScopes: WRITER },
        );
        const openVault = await v.call(
          "append_note",
          { vault: "other", path: "F/SCHEMA.md", content: "y\n" },
          { grantedScopes: WRITER },
        );
        expect(denial(protectedVault)).toMatchObject(SCHEMA_REFUSAL);
        expect(openVault.ok).toBe(true);
      },
    );
  });

  it("a case variant of the layer name is protected where the filesystem folds case", async () => {
    await withVault({ ...PROTECTED, files: { "F/schema.md": LAYER } }, async (v) => {
      const r = await v.call(
        "append_note",
        { vault: "test", path: "F/schema.md", content: "y\n" },
        { grantedScopes: WRITER },
      );
      if (CASE_INSENSITIVE_FS) expect(denial(r)).toMatchObject(SCHEMA_REFUSAL);
      else expect(r.ok).toBe(true);
    });
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
      const admin = await inspect(["write:*", "admin:conventions"]);
      expect(writer).toMatchObject({
        ok: true,
        data: { allowed: false, denied_by: "schema_file" },
      });
      expect(admin).toMatchObject({ ok: true, data: { allowed: true } });
    } finally {
      v.cleanup();
    }
  });

  it("inspect_acl and enforcement agree on an out-of-whitelist G/SCHEMA.md", async () => {
    const v = makeM6Vault({
      acl: { protectSchemaFiles: true, writePaths: ["F/**"] },
      files: { "G/SCHEMA.md": LAYER },
      register: (r, d) => {
        for (const t of buildAdminTools(d)) r.register(t);
      },
    });
    try {
      const i = await v.call("inspect_acl", {
        vault: "test",
        path: "G/SCHEMA.md",
        op: "write",
        scopes: ["write:*"],
      });
      expect(i).toMatchObject({ ok: true, data: { allowed: false, denied_by: "write_paths" } });
    } finally {
      v.cleanup();
    }
    await withVault({ ...PROTECTED, files: { "G/SCHEMA.md": LAYER } }, async (w) => {
      const r = await w.call(
        "append_note",
        { vault: "test", path: "G/SCHEMA.md", content: "y\n" },
        { grantedScopes: WRITER },
      );
      expect(r.ok ? "" : r.error.message).toMatch(/whitelist/);
    });
  });

  it("inspect_acl and enforcement agree on a symlink named SCHEMA.md", async () => {
    const make = (root: string) => {
      mkdirSync(join(root, "F"), { recursive: true });
      writeFileSync(join(root, "F", "rules.md"), "r\n");
      symlinkSync("rules.md", join(root, "F", "SCHEMA.md"));
    };
    const v = makeM6Vault({
      acl: { protectSchemaFiles: true, writePaths: ["F/**"], deletePaths: ["F/**"] },
      register: (r, d) => {
        for (const t of buildAdminTools(d)) r.register(t);
      },
    });
    cleanups.push(() => v.cleanup());
    make(v.root);
    const i = await v.call("inspect_acl", {
      vault: "test",
      path: "F/SCHEMA.md",
      op: "delete",
      scopes: ["delete:*"],
    });
    expect(i).toMatchObject({ ok: true, data: { allowed: false, denied_by: "schema_file" } });
    await withVault(
      {
        ...PROTECTED,
        files: { "F/rules.md": "r\n" },
        setup: (root) => symlinkSync("rules.md", join(root, "F", "SCHEMA.md")),
      },
      async (w) => {
        const r = await confirmedCall(
          w,
          "delete_note",
          { vault: "test", path: "F/SCHEMA.md" },
          { grantedScopes: WRITER },
        );
        expect(denial(r)).toMatchObject(SCHEMA_REFUSAL);
      },
    );
  });
});
