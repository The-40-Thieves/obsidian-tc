// A note whose frontmatter is not valid YAML must stay readable and repairable, and must not take
// a whole-vault tool down with it. Eval evidence (write-ergonomics, task repair-broken-yaml, 0/3 on
// Claude Code and Codex): read_note, patch_note and update_frontmatter all refused with
// invalid_input, so only an approval-gated write_note overwrite worked. And one such note made
// get_backlinks / find_orphans fail for the WHOLE vault.
import type { ErrorJSON } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { formatErrorDetail } from "../src/mcp/error-rendering";
import { parseNote } from "../src/vault/frontmatter";
import { makeTestVault } from "./m1-helpers";
import { makeM2Vault } from "./m2-helpers";
import { makeM3Vault } from "./m3-helpers";

// The eval fixture's shape: an unterminated quote and an unterminated flow sequence.
const BROKEN =
  '---\ntitle: "Messy\ntags: [a, b\ndate: 2026-09-12\n---\n# Messy\n\nBody [[target]].\n';
const FIXED_YAML = 'title: "Messy"\ntags: [a, b]\ndate: 2026-09-12';
const BASE_FILES = {
  "target.md": "# Target\n",
  "linker.md": "See [[target]].\n",
  "broken.md": BROKEN,
};

type Data = Record<string, unknown>;
const dataOf = (r: { ok: boolean; data?: unknown; error?: unknown }): Data => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.data as Data;
};

describe("read on an unparseable-frontmatter note", () => {
  it("read_note returns the raw content, raw frontmatter, error location and a repair warning", async () => {
    const v = makeTestVault({ files: BASE_FILES });
    try {
      const d = dataOf(await v.call("read_note", { vault: "test", path: "broken.md" }));
      expect(d.content).toBe(BROKEN);
      expect(d.frontmatter).toBeNull();
      expect(d.has_frontmatter).toBe(true);
      expect(d.body).toBe("# Messy\n\nBody [[target]].\n");
      expect(d.raw_frontmatter).toBe('title: "Messy\ntags: [a, b\ndate: 2026-09-12');
      const loc = d.frontmatter_error as { message: string; line: number; column: number };
      expect(loc.message).toContain("frontmatter is not valid YAML");
      // 1-based position in the FILE: the opening --- is line 1, so the block starts on line 2.
      expect(loc.line).toBeGreaterThanOrEqual(2);
      expect(loc.column).toBeGreaterThanOrEqual(1);
      expect(String(d.warning)).toContain("update_frontmatter");
    } finally {
      v.cleanup();
    }
  });

  it("read_note concise still carries what a repair needs", async () => {
    const v = makeTestVault({ files: BASE_FILES });
    try {
      const d = dataOf(
        await v.call("read_note", { vault: "test", path: "broken.md", response_format: "concise" }),
      );
      expect(d.body).toBe("# Messy\n\nBody [[target]].\n");
      expect(d.raw_frontmatter).toContain('title: "Messy');
      expect(d.frontmatter_error).toBeDefined();
      expect(d.content_hash).toEqual(expect.any(String));
    } finally {
      v.cleanup();
    }
  });

  it("read_note on a healthy note has none of the repair fields", async () => {
    const v = makeTestVault({ files: BASE_FILES });
    try {
      const d = dataOf(await v.call("read_note", { vault: "test", path: "target.md" }));
      expect(d.raw_frontmatter).toBeUndefined();
      expect(d.frontmatter_error).toBeUndefined();
      expect(d.warning).toBeUndefined();
    } finally {
      v.cleanup();
    }
  });

  it("read_notes returns the broken note as a note, not a per-path error", async () => {
    const v = makeTestVault({ files: BASE_FILES });
    try {
      const d = dataOf(
        await v.call("read_notes", { vault: "test", paths: ["broken.md", "target.md"] }),
      );
      expect(d.errors).toEqual([]);
      const notes = d.notes as Array<Data>;
      expect(notes.map((n) => n.path)).toEqual(["broken.md", "target.md"]);
      expect(notes[0]?.raw_frontmatter).toContain('title: "Messy');
    } finally {
      v.cleanup();
    }
  });
});

describe("repair of an unparseable-frontmatter note", () => {
  it("update_frontmatter replace with frontmatter_yaml repairs it with no approval, body untouched", async () => {
    const v = makeTestVault({ files: BASE_FILES });
    try {
      const read = dataOf(await v.call("read_note", { vault: "test", path: "broken.md" }));
      const r = await v.call("update_frontmatter", {
        vault: "test",
        path: "broken.md",
        operation: "replace",
        frontmatter_yaml: FIXED_YAML,
        prev_hash: read.content_hash,
      });
      expect(r.ok).toBe(true);
      const after = v.read("broken.md");
      expect(after).toBe(`---\n${FIXED_YAML}\n---\n# Messy\n\nBody [[target]].\n`);
      const p = parseNote(after);
      expect(p.frontmatter).toMatchObject({ title: "Messy", tags: ["a", "b"] });
      // and the note reads cleanly afterwards
      const again = dataOf(await v.call("read_note", { vault: "test", path: "broken.md" }));
      expect(again.warning).toBeUndefined();
    } finally {
      v.cleanup();
    }
  });

  it("update_frontmatter replace with a properties object also repairs it with no approval", async () => {
    const v = makeTestVault({ files: BASE_FILES });
    try {
      const r = await v.call("update_frontmatter", {
        vault: "test",
        path: "broken.md",
        operation: "replace",
        properties: { title: "Messy", tags: ["a", "b"] },
      });
      expect(r.ok).toBe(true);
      expect(parseNote(v.read("broken.md")).frontmatter).toEqual({
        title: "Messy",
        tags: ["a", "b"],
      });
      expect(v.read("broken.md").endsWith("# Messy\n\nBody [[target]].\n")).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("keeps CAS: a stale prev_hash is refused and nothing is written", async () => {
    const v = makeTestVault({ files: BASE_FILES });
    try {
      const r = await v.call("update_frontmatter", {
        vault: "test",
        path: "broken.md",
        operation: "replace",
        frontmatter_yaml: FIXED_YAML,
        prev_hash: "0".repeat(64),
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("concurrent_modification");
      expect(v.read("broken.md")).toBe(BROKEN);
    } finally {
      v.cleanup();
    }
  });

  it("refuses a replacement that is still not valid YAML, with the parse error, and writes nothing", async () => {
    const v = makeTestVault({ files: BASE_FILES });
    try {
      const r = await v.call("update_frontmatter", {
        vault: "test",
        path: "broken.md",
        operation: "replace",
        frontmatter_yaml: "title: [unclosed\nother: 1",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("invalid_input");
        expect(r.error.message).toContain("not valid YAML");
      }
      expect(v.read("broken.md")).toBe(BROKEN);
    } finally {
      v.cleanup();
    }
  });

  it("refuses a replacement carrying a --- line, which would close the block early", async () => {
    const v = makeTestVault({ files: BASE_FILES });
    try {
      const r = await v.call("update_frontmatter", {
        vault: "test",
        path: "broken.md",
        operation: "replace",
        frontmatter_yaml: "title: ok\n---\nsneaky: body",
      });
      expect(r.ok).toBe(false);
      expect(v.read("broken.md")).toBe(BROKEN);
    } finally {
      v.cleanup();
    }
  });

  it("frontmatter_yaml is only valid with operation replace and not beside properties", async () => {
    const v = makeTestVault({ files: BASE_FILES });
    try {
      const withSet = await v.call("update_frontmatter", {
        vault: "test",
        path: "target.md",
        operation: "set",
        key: "a",
        value: 1,
        frontmatter_yaml: "a: 1",
      });
      expect(withSet.ok).toBe(false);
      const both = await v.call("update_frontmatter", {
        vault: "test",
        path: "broken.md",
        operation: "replace",
        frontmatter_yaml: FIXED_YAML,
        properties: { a: 1 },
      });
      expect(both.ok).toBe(false);
    } finally {
      v.cleanup();
    }
  });

  it("a replace on a note that PARSES still needs approval (the gate is only lifted when there is nothing to discard)", async () => {
    const v = makeTestVault({ files: { "ok.md": "---\ntitle: Keep\n---\nbody\n" } });
    try {
      const r = await v.call("update_frontmatter", {
        vault: "test",
        path: "ok.md",
        operation: "replace",
        frontmatter_yaml: "title: Gone",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("elicit_required");
      expect(v.read("ok.md")).toBe("---\ntitle: Keep\n---\nbody\n");
    } finally {
      v.cleanup();
    }
  });

  it("set/merge/remove on a broken note are still refused (frontmatter_yaml), naming the repair tool", async () => {
    const v = makeTestVault({ files: BASE_FILES });
    try {
      const r = await v.call("update_frontmatter", {
        vault: "test",
        path: "broken.md",
        operation: "set",
        key: "a",
        value: 1,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.details?.reason).toBe("frontmatter_yaml");
        expect(formatErrorDetail(r.error as ErrorJSON)).toContain("update_frontmatter");
        expect(formatErrorDetail(r.error as ErrorJSON)).toContain("frontmatter_yaml");
      }
      expect(v.read("broken.md")).toBe(BROKEN);
    } finally {
      v.cleanup();
    }
  });

  it("patch_note and read_frontmatter refusals carry the same repair hint", async () => {
    const v = makeTestVault({ files: BASE_FILES });
    try {
      for (const [name, args] of [
        ["read_frontmatter", { vault: "test", path: "broken.md" }],
        [
          "patch_note",
          {
            vault: "test",
            path: "broken.md",
            operation: "append",
            anchor: { type: "frontmatter" },
            content: "x",
          },
        ],
      ] as const) {
        const r = await v.call(name, args);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(formatErrorDetail(r.error as ErrorJSON)).toContain("update_frontmatter");
      }
    } finally {
      v.cleanup();
    }
  });

  it("the write ACL is unchanged: a read-only path is still refused, broken or not", async () => {
    const v = makeTestVault({
      files: { "ro/broken.md": BROKEN, "rw/broken.md": BROKEN },
      acl: { writePaths: ["rw/**"] },
    });
    try {
      const denied = await v.call("update_frontmatter", {
        vault: "test",
        path: "ro/broken.md",
        operation: "replace",
        frontmatter_yaml: FIXED_YAML,
      });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe("acl_denied");
      expect(v.read("ro/broken.md")).toBe(BROKEN);
      const allowed = await v.call("update_frontmatter", {
        vault: "test",
        path: "rw/broken.md",
        operation: "replace",
        frontmatter_yaml: FIXED_YAML,
      });
      expect(allowed.ok).toBe(true);
    } finally {
      v.cleanup();
    }
  });
});

describe("whole-vault tools with one unparseable-frontmatter note", () => {
  const FILES = {
    ...BASE_FILES,
    "board.md": "---\nkanban-plugin: board\n---\n## Todo\n\n- [ ] a\n",
    "p.md": "---\nstatus: open\n---\nbody #tagged\n",
  };
  // Every whole-vault caller found by grepping parseNote across the tools: each must return its
  // results for the readable notes and name broken.md in `warnings`, not fail with invalid_input.
  const CALLS: Array<[string, Record<string, unknown>]> = [
    ["get_backlinks", { path: "target.md" }],
    ["get_outgoing_links", { path: "broken.md" }],
    ["find_orphans", {}],
    ["find_unresolved_links", {}],
    ["vault_health_score", {}],
    ["find_link_cycles", {}],
    ["get_link_strength", { from: "linker.md", to: "target.md" }],
    ["suggest_links", { path: "linker.md" }],
    ["audit_provenance", {}],
    ["list_properties", {}],
    ["find_notes_by_property", { key: "status" }],
    ["list_tags", {}],
    ["find_notes_by_tag", { tag: "tagged" }],
  ];

  for (const [name, args] of CALLS) {
    it(`${name} returns results and a warning naming the broken note`, async () => {
      const v = makeTestVault({ files: FILES });
      try {
        const d = dataOf(await v.call(name, { vault: "test", ...args }));
        const warnings = d.warnings as Array<{ path: string; reason: string }> | undefined;
        expect(warnings?.map((w) => w.path)).toEqual(["broken.md"]);
        expect(warnings?.[0]?.reason).toBe("frontmatter_yaml");
      } finally {
        v.cleanup();
      }
    });
  }

  it("get_backlinks still finds every readable linker, including the broken note's own body link", async () => {
    const v = makeTestVault({ files: FILES });
    try {
      const d = dataOf(await v.call("get_backlinks", { vault: "test", path: "target.md" }));
      expect(
        (d.backlinks as Array<{ source_path: string }>).map((b) => b.source_path).sort(),
      ).toEqual(["broken.md", "linker.md"]);
    } finally {
      v.cleanup();
    }
  });

  it("find_orphans: the broken note's body links still count, so its targets are not false orphans", async () => {
    const v = makeTestVault({ files: FILES });
    try {
      const d = dataOf(await v.call("find_orphans", { vault: "test" }));
      expect(d.orphans as string[]).not.toContain("target.md");
    } finally {
      v.cleanup();
    }
  });

  it("a clean vault reports no warnings key", async () => {
    const v = makeTestVault({ files: { "a.md": "[[b]]", "b.md": "x" } });
    try {
      const d = dataOf(await v.call("get_backlinks", { vault: "test", path: "b.md" }));
      expect("warnings" in d).toBe(false);
    } finally {
      v.cleanup();
    }
  });

  it("warnings never name a note the caller cannot read", async () => {
    const v = makeTestVault({
      files: {
        "pub/target.md": "# T\n",
        "pub/linker.md": "[[target]]",
        "secret/broken.md": BROKEN,
      },
      acl: { readPaths: ["pub/**"] },
    });
    try {
      for (const [name, args] of [
        ["get_backlinks", { path: "pub/target.md" }],
        ["find_orphans", {}],
        ["find_unresolved_links", {}],
        ["vault_health_score", {}],
        ["list_properties", {}],
        ["list_tags", {}],
      ] as const) {
        const r = await v.call(name, { vault: "test", ...args });
        expect(JSON.stringify(r)).not.toContain("secret/broken.md");
        expect(dataOf(r).warnings).toBeUndefined();
      }
    } finally {
      v.cleanup();
    }
  });

  it("caps the warnings list and counts the rest", async () => {
    const files: Record<string, string> = { "target.md": "# T\n" };
    for (let i = 0; i < 55; i++) files[`b${i}.md`] = BROKEN;
    const v = makeTestVault({ files });
    try {
      const d = dataOf(await v.call("find_orphans", { vault: "test" }));
      expect((d.warnings as unknown[]).length).toBe(50);
      expect(d.warnings_omitted).toBe(5);
    } finally {
      v.cleanup();
    }
  });
});

describe("the eval repro, as a test", () => {
  it("get_backlinks and find_orphans succeed for the whole vault", async () => {
    const v = makeTestVault({
      files: {
        "target.md": "# Target\n",
        "linker.md": "See [[target]].\n",
        "broken.md": '---\ntitle: "Messy\ntags: [a]\n---\nbody\n',
      },
    });
    try {
      const bl = dataOf(await v.call("get_backlinks", { vault: "test", path: "target.md" }));
      expect((bl.backlinks as Array<{ source_path: string }>).map((b) => b.source_path)).toEqual([
        "linker.md",
      ]);
      const orphans = dataOf(await v.call("find_orphans", { vault: "test" }));
      expect((orphans.orphans as string[]).sort()).toEqual(["broken.md", "linker.md"]);
    } finally {
      v.cleanup();
    }
  });
});

describe("whole-vault tools in the search and structured domains", () => {
  const FILES = {
    "broken.md": BROKEN,
    "p.md": "---\nstatus: open\n---\nbody\n",
    "board.md": "---\nkanban-plugin: board\n---\n## Todo\n\n- [ ] a\n",
    "q.base": "views:\n  - name: All\n    type: table\n",
  };
  const named = (d: Data) =>
    (d.warnings as Array<{ path: string }> | undefined)?.map((w) => w.path);

  it("search_jsonlogic and search_vault (jsonlogic mode) return matches and name the broken note", async () => {
    const v = makeM2Vault({ files: FILES });
    try {
      const logic = { "==": [{ var: "status" }, "open"] };
      const a = dataOf(await v.call("search_jsonlogic", { vault: "test", logic }));
      expect((a.items as Array<{ path: string }>).map((i) => i.path)).toEqual(["p.md"]);
      expect(named(a)).toEqual(["broken.md"]);
      const b = dataOf(await v.call("search_vault", { vault: "test", query: logic }));
      expect((b.items as Array<{ path: string }>).map((i) => i.path)).toEqual(["p.md"]);
      expect(named(b)).toEqual(["broken.md"]);
    } finally {
      v.cleanup();
    }
  });

  it("list_kanban_boards and query_base return results and name the broken note", async () => {
    const v = makeM3Vault({ files: FILES });
    try {
      const boards = dataOf(await v.call("list_kanban_boards", { vault: "test" }));
      expect((boards.boards as Array<{ path: string }>).map((b) => b.path)).toEqual(["board.md"]);
      expect(named(boards)).toEqual(["broken.md"]);
      const q = dataOf(await v.call("query_base", { vault: "test", path: "q.base" }));
      expect(named(q)).toEqual(["broken.md"]);
    } finally {
      v.cleanup();
    }
  });
});
