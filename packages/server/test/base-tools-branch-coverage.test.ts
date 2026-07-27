// THE-602 — branch-coverage fill for src/tools/m3/base-tools.ts. Every case here asserts real
// caller-visible behavior (an error code, a returned value, or a state change), not just that a
// line ran. See the module-level comment in base-tools.ts for the domain background; the other
// base*.test.ts files cover the "happy path" shapes this file deliberately does not repeat.
import { describe, expect, it } from "vitest";
import { makeM3Vault } from "./m3-helpers";

describe("base-tools branch coverage: create_base structural checks", () => {
  it("rejects creating over an existing folder with invalid_input, not note_exists", async () => {
    const v = makeM3Vault({ files: { "adir.base/child.md": "x" } });
    try {
      const r = await v.call("create_base", {
        vault: "test",
        path: "adir.base",
        base: { views: [] },
        overwrite: true,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });

  it("rejects creating over an existing file when overwrite is left at its default (false)", async () => {
    const v = makeM3Vault({ files: { "p.base": "views: []\n" } });
    try {
      const r = await v.call("create_base", {
        vault: "test",
        path: "p.base",
        base: { views: [] },
        // overwrite omitted -> defaults false
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("note_exists");
    } finally {
      v.cleanup();
    }
  });

  it("a base with neither `source` nor `views` creates cleanly with no deprecations reported", async () => {
    const v = makeM3Vault();
    try {
      const r = await v.call("create_base", {
        vault: "test",
        path: "bare.base",
        base: { properties: { icon: "book" } },
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { deprecations?: string[]; created: boolean };
        expect(d.created).toBe(true);
        expect(d.deprecations).toBeUndefined();
      }
    } finally {
      v.cleanup();
    }
  });
});

describe("base-tools branch coverage: update_base structural checks", () => {
  it("rejects patching a base path that is actually a folder with note_not_found", async () => {
    const v = makeM3Vault({ files: { "adir.base/child.md": "x" } });
    try {
      const r = await v.call("update_base", {
        vault: "test",
        path: "adir.base",
        patch: { properties: { icon: "x" } },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("note_not_found");
    } finally {
      v.cleanup();
    }
  });

  it("a prev_hash that MATCHES the current content hash is accepted (not concurrent_modification)", async () => {
    const v = makeM3Vault({ files: { "p.base": "views: []\n" } });
    try {
      const read = await v.call("read_base", { vault: "test", path: "p.base" });
      expect(read.ok).toBe(true);
      const hash = (read.ok && (read.data as { content_hash: string }).content_hash) as string;
      const r = await v.call("update_base", {
        vault: "test",
        path: "p.base",
        patch: { properties: { icon: "x" } },
        prev_hash: hash,
      });
      expect(r.ok).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("patch.properties is applied and round-trips through read_base", async () => {
    const v = makeM3Vault({ files: { "p.base": "views: []\n" } });
    try {
      const r = await v.call("update_base", {
        vault: "test",
        path: "p.base",
        patch: { properties: { icon: "book", hidden: ["file.ctime"] } },
      });
      expect(r.ok).toBe(true);
      const read = await v.call("read_base", { vault: "test", path: "p.base" });
      if (read.ok) {
        const base = (read.data as { base: Record<string, unknown> }).base;
        expect(base.properties).toEqual({ icon: "book", hidden: ["file.ctime"] });
      }
    } finally {
      v.cleanup();
    }
  });

  it("remove_views removing a name that does not exist reports views_removed: 0", async () => {
    const v = makeM3Vault({ files: { "p.base": "views:\n  - name: Keep\n    type: table\n" } });
    try {
      const r = await v.call("update_base", {
        vault: "test",
        path: "p.base",
        patch: { remove_views: ["Ghost"] },
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { applied: { views_removed: number } };
        expect(d.applied.views_removed).toBe(0);
      }
      const read = await v.call("read_base", { vault: "test", path: "p.base" });
      if (read.ok) {
        const views = (read.data as { base: { views: Array<{ name: string }> } }).base.views;
        expect(views.map((w) => w.name)).toEqual(["Keep"]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("remove_views removing an existing name actually deletes it", async () => {
    const v = makeM3Vault({
      files: { "p.base": "views:\n  - name: A\n    type: table\n  - name: B\n    type: table\n" },
    });
    try {
      const r = await v.call("update_base", {
        vault: "test",
        path: "p.base",
        patch: { remove_views: ["A"] },
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { applied: { views_removed: number } };
        expect(d.applied.views_removed).toBe(1);
      }
      const read = await v.call("read_base", { vault: "test", path: "p.base" });
      if (read.ok) {
        const views = (read.data as { base: { views: Array<{ name: string }> } }).base.views;
        expect(views.map((w) => w.name)).toEqual(["B"]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("add_views on a base with no pre-existing `views` key creates the array", async () => {
    const v = makeM3Vault({ files: { "p.base": "properties: {}\n" } });
    try {
      const r = await v.call("update_base", {
        vault: "test",
        path: "p.base",
        patch: { add_views: [{ name: "New", type: "table" }] },
      });
      expect(r.ok).toBe(true);
      const read = await v.call("read_base", { vault: "test", path: "p.base" });
      if (read.ok) {
        const views = (read.data as { base: { views: Array<{ name: string }> } }).base.views;
        expect(views.map((w) => w.name)).toEqual(["New"]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("patch.formulas merges onto an EXISTING formulas map", async () => {
    const v = makeM3Vault({
      files: { "p.base": "views: []\nformulas:\n  a:\n    '*':\n      - 1\n      - 2\n" },
    });
    try {
      const r = await v.call("update_base", {
        vault: "test",
        path: "p.base",
        patch: { formulas: { b: { "+": [1, 1] } } },
      });
      expect(r.ok).toBe(true);
      const read = await v.call("read_base", { vault: "test", path: "p.base" });
      if (read.ok) {
        const formulas = (read.data as { base: { formulas: Record<string, unknown> } }).base
          .formulas;
        expect(Object.keys(formulas).sort()).toEqual(["a", "b"]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("patch.formulas on a base with NO existing formulas key starts a fresh map", async () => {
    const v = makeM3Vault({ files: { "p.base": "views: []\n" } });
    try {
      const r = await v.call("update_base", {
        vault: "test",
        path: "p.base",
        patch: { formulas: { b: { "+": [1, 1] } } },
      });
      expect(r.ok).toBe(true);
      const read = await v.call("read_base", { vault: "test", path: "p.base" });
      if (read.ok) {
        const formulas = (read.data as { base: { formulas: Record<string, unknown> } }).base
          .formulas;
        expect(Object.keys(formulas)).toEqual(["b"]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("update_views naming a view that does not exist is a silent no-op (views_updated stays 0)", async () => {
    const v = makeM3Vault({ files: { "p.base": "views:\n  - name: Real\n    type: table\n" } });
    try {
      const r = await v.call("update_base", {
        vault: "test",
        path: "p.base",
        patch: { update_views: { Ghost: { type: "cards" } } },
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { applied: { views_updated: number } };
        expect(d.applied.views_updated).toBe(0);
      }
      const read = await v.call("read_base", { vault: "test", path: "p.base" });
      if (read.ok) {
        const views = (read.data as { base: { views: Array<{ type: string }> } }).base.views;
        expect(views[0]?.type).toBe("table"); // unchanged
      }
    } finally {
      v.cleanup();
    }
  });

  it("a patch that produces a structurally invalid base is refused as bases_syntax_error, unwritten", async () => {
    const v = makeM3Vault({ files: { "p.base": "views: []\n" } });
    try {
      const r = await v.call("update_base", {
        vault: "test",
        path: "p.base",
        // BaseView.limit is a positive int; -1 fails BaseDoc validation post-patch.
        patch: { add_views: [{ name: "Bad", type: "table", limit: -1 }] },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("bases_syntax_error");
      // the file on disk must be untouched by the rejected patch.
      expect(v.read("p.base")).toBe("views: []\n");
    } finally {
      v.cleanup();
    }
  });
});

describe("base-tools branch coverage: query_base view selection", () => {
  it("querying a .base path that does not exist is note_not_found", async () => {
    const v = makeM3Vault();
    try {
      const r = await v.call("query_base", { vault: "test", path: "ghost.base" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("note_not_found");
    } finally {
      v.cleanup();
    }
  });

  it("an explicit view name that does not exist is invalid_input", async () => {
    const v = makeM3Vault({
      files: { "p.base": "views:\n  - name: Real\n    type: table\n" },
    });
    try {
      const r = await v.call("query_base", { vault: "test", path: "p.base", view: "Ghost" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });

  it("a base with no views at all still queries (view_used null, default path column)", async () => {
    const v = makeM3Vault({
      files: { "p.base": "properties: {}\n", "a.md": "---\nstatus: x\n---\nbody" },
    });
    try {
      const r = await v.call("query_base", { vault: "test", path: "p.base" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as {
          view_used: string | null;
          items: Array<{ note_path: string; columns: Record<string, unknown> }>;
        };
        expect(d.view_used).toBeNull();
        expect(d.items.map((i) => i.note_path)).toEqual(["a.md"]);
        expect(d.items[0]?.columns).toEqual({ path: "a.md" });
      }
    } finally {
      v.cleanup();
    }
  });
});

describe("base-tools branch coverage: source type narrowing", () => {
  it("source type tag includes tagged notes and excludes untagged ones", async () => {
    const v = makeM3Vault({
      files: {
        "p.base": "source:\n  type: tag\n  value: keep\nviews:\n  - name: V\n    type: table\n",
        "yes.md": "---\ntags: [keep]\n---\nx",
        "no.md": "---\ntags: [other]\n---\ny",
      },
    });
    try {
      const r = await v.call("query_base", { vault: "test", path: "p.base" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { items: Array<{ note_path: string }> };
        expect(d.items.map((i) => i.note_path)).toEqual(["yes.md"]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("source type tag: a note with a single non-array `tag` (singular key) still matches", async () => {
    const v = makeM3Vault({
      files: {
        "p.base": "source:\n  type: tag\n  value: solo\nviews:\n  - name: V\n    type: table\n",
        "yes.md": "---\ntag: solo\n---\nx",
      },
    });
    try {
      const r = await v.call("query_base", { vault: "test", path: "p.base" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { items: Array<{ note_path: string }> };
        expect(d.items.map((i) => i.note_path)).toEqual(["yes.md"]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("source type property includes notes carrying the key and excludes those without it", async () => {
    const v = makeM3Vault({
      files: {
        "p.base":
          "source:\n  type: property\n  value: priority\nviews:\n  - name: V\n    type: table\n",
        "has.md": "---\npriority: 1\n---\nx",
        "hasnt.md": "---\nother: 1\n---\ny",
      },
    });
    try {
      const r = await v.call("query_base", { vault: "test", path: "p.base" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { items: Array<{ note_path: string }> };
        expect(d.items.map((i) => i.note_path)).toEqual(["has.md"]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("source type folder with a null `value` matches every note (empty-prefix fallback)", async () => {
    const v = makeM3Vault({
      files: {
        "p.base": "source:\n  type: folder\n  value: ~\nviews:\n  - name: V\n    type: table\n",
        "root.md": "---\n---\nx",
        "sub/nested.md": "---\n---\ny",
      },
    });
    try {
      const r = await v.call("query_base", { vault: "test", path: "p.base" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { items: Array<{ note_path: string }> };
        expect(d.items.map((i) => i.note_path).sort()).toEqual(["root.md", "sub/nested.md"]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("source type link: resolved target matches only linking notes; unresolved target matches none", async () => {
    const v = makeM3Vault({
      files: {
        "linked.base":
          "source:\n  type: link\n  value: target\nviews:\n  - name: V\n    type: table\n",
        "unresolved.base":
          "source:\n  type: link\n  value: nowhere-at-all\nviews:\n  - name: V\n    type: table\n",
        "target.md": "---\n---\nt",
        "linker.md": "---\n---\n[[target]]",
        "nonlinker.md": "---\n---\nno links here",
      },
    });
    try {
      const hit = await v.call("query_base", { vault: "test", path: "linked.base" });
      expect(hit.ok).toBe(true);
      if (hit.ok) {
        const d = hit.data as { items: Array<{ note_path: string }> };
        expect(d.items.map((i) => i.note_path)).toEqual(["linker.md"]);
      }
      const miss = await v.call("query_base", { vault: "test", path: "unresolved.base" });
      expect(miss.ok).toBe(true);
      if (miss.ok) expect((miss.data as { items: unknown[] }).items).toEqual([]);
    } finally {
      v.cleanup();
    }
  });

  it("source type link with a null `value` resolves to no target, so no notes match", async () => {
    const v = makeM3Vault({
      files: {
        "p.base": "source:\n  type: link\n  value: ~\nviews:\n  - name: V\n    type: table\n",
        "a.md": "---\n---\n[[a]]",
      },
    });
    try {
      const r = await v.call("query_base", { vault: "test", path: "p.base" });
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.data as { items: unknown[] }).items).toEqual([]);
    } finally {
      v.cleanup();
    }
  });

  it("a note with no frontmatter block at all is handled (excluded from a property-source query)", async () => {
    const v = makeM3Vault({
      files: {
        "p.base":
          "source:\n  type: property\n  value: status\nviews:\n  - name: V\n    type: table\n",
        "plain.md": "just body text, no frontmatter",
        "has.md": "---\nstatus: x\n---\ny",
      },
    });
    try {
      const r = await v.call("query_base", { vault: "test", path: "p.base" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { items: Array<{ note_path: string }> };
        expect(d.items.map((i) => i.note_path)).toEqual(["has.md"]);
      }
    } finally {
      v.cleanup();
    }
  });
});

describe("base-tools branch coverage: view-level DSL filter (as opposed to top-level)", () => {
  it("a view's own string `filters` (Bases DSL) narrows the note set", async () => {
    const v = makeM3Vault({
      files: {
        "p.base": 'views:\n  - name: V\n    type: table\n    filters: file.hasTag("keep")\n',
        "yes.md": "---\ntags: [keep]\n---\nx",
        "no.md": "---\ntags: [drop]\n---\ny",
      },
    });
    try {
      const r = await v.call("query_base", { vault: "test", path: "p.base" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { items: Array<{ note_path: string }> };
        expect(d.items.map((i) => i.note_path)).toEqual(["yes.md"]);
      }
    } finally {
      v.cleanup();
    }
  });
});

describe("base-tools branch coverage: idValue namespaced ids", () => {
  it("file.folder resolves '' at vault root and the parent dir when nested", async () => {
    const v = makeM3Vault({
      files: {
        "p.base":
          "views:\n  - name: V\n    type: table\n    order:\n      - file.path\n      - file.folder\n",
        "root.md": "---\n---\nx",
        "sub/nested.md": "---\n---\ny",
      },
    });
    try {
      const r = await v.call("query_base", { vault: "test", path: "p.base" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as {
          items: Array<{ note_path: string; columns: Record<string, unknown> }>;
        };
        const root = d.items.find((i) => i.note_path === "root.md");
        const nested = d.items.find((i) => i.note_path === "sub/nested.md");
        expect(root?.columns["file.folder"]).toBe("");
        expect(nested?.columns["file.folder"]).toBe("sub");
      }
    } finally {
      v.cleanup();
    }
  });

  it("file.ext is always 'md'; a formula.* id absent from `formulas` resolves to null", async () => {
    const v = makeM3Vault({
      files: {
        "p.base":
          "views:\n  - name: V\n    type: table\n    order:\n      - file.ext\n      - formula.ghost\n",
        "a.md": "---\n---\nx",
      },
    });
    try {
      const r = await v.call("query_base", { vault: "test", path: "p.base" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { items: Array<{ columns: Record<string, unknown> }> };
        expect(d.items[0]?.columns["file.ext"]).toBe("md");
        expect(d.items[0]?.columns["formula.ghost"]).toBeNull();
      }
    } finally {
      v.cleanup();
    }
  });

  it("a note.* id absent from a note's frontmatter resolves to null", async () => {
    const v = makeM3Vault({
      files: {
        "p.base": "views:\n  - name: V\n    type: table\n    order:\n      - note.missing\n",
        "a.md": "---\nother: 1\n---\nx",
      },
    });
    try {
      const r = await v.call("query_base", { vault: "test", path: "p.base" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { items: Array<{ columns: Record<string, unknown> }> };
        expect(d.items[0]?.columns["note.missing"]).toBeNull();
      }
    } finally {
      v.cleanup();
    }
  });
});

describe("base-tools branch coverage: deprecated column projection", () => {
  it("the deprecated `columns` alias can project file.path / path and nulls a missing property", async () => {
    const v = makeM3Vault({
      files: {
        "p.base":
          "views:\n  - name: V\n    type: table\n    columns:\n      - file.path\n      - missing\n",
        "a.md": "---\n---\nx",
      },
    });
    try {
      const r = await v.call("query_base", { vault: "test", path: "p.base" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { items: Array<{ columns: Record<string, unknown> }> };
        expect(d.items[0]?.columns["file.path"]).toBe("a.md");
        expect(d.items[0]?.columns.missing).toBeNull();
      }
    } finally {
      v.cleanup();
    }
  });
});

describe("base-tools branch coverage: groupBy variants", () => {
  it("groupBy as a bare string (no direction object) groups ASC by default", async () => {
    const v = makeM3Vault({
      files: {
        "p.base": "views:\n  - name: V\n    type: table\n    groupBy: status\n",
        "z.md": "---\nstatus: zeta\n---\nz",
        "a.md": "---\nstatus: alpha\n---\na",
      },
    });
    try {
      const r = await v.call("query_base", { vault: "test", path: "p.base" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { items: Array<{ note_path: string; group?: unknown }> };
        // ASC group order -> alpha before zeta.
        expect(d.items.map((i) => i.note_path)).toEqual(["a.md", "z.md"]);
        expect(d.items[0]?.group).toBe("alpha");
      }
    } finally {
      v.cleanup();
    }
  });

  it("groupBy with no `sort` key still groups (groupProp alone drives the ordering)", async () => {
    const v = makeM3Vault({
      files: {
        "p.base":
          "views:\n  - name: V\n    type: table\n    groupBy:\n      property: status\n      direction: DESC\n",
        "a.md": "---\nstatus: alpha\n---\na",
        "z.md": "---\nstatus: zeta\n---\nz",
      },
    });
    try {
      const r = await v.call("query_base", { vault: "test", path: "p.base" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { items: Array<{ note_path: string }> };
        // DESC group order -> zeta before alpha, with no explicit sort.
        expect(d.items.map((i) => i.note_path)).toEqual(["z.md", "a.md"]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("rows tied on groupBy fall through to the sort spec to break the tie", async () => {
    const v = makeM3Vault({
      files: {
        "p.base":
          "views:\n  - name: V\n    type: table\n    groupBy: status\n    sort:\n      - property: note.rank\n",
        "second.md": "---\nstatus: same\nrank: 2\n---\nb",
        "first.md": "---\nstatus: same\nrank: 1\n---\na",
      },
    });
    try {
      const r = await v.call("query_base", { vault: "test", path: "p.base" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { items: Array<{ note_path: string }> };
        // Same group ("same") -> tie on groupBy -> broken by the ASC rank sort.
        expect(d.items.map((i) => i.note_path)).toEqual(["first.md", "second.md"]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("a group id that is absent on a note resolves the row's `group` to null", async () => {
    const v = makeM3Vault({
      files: {
        "p.base": "views:\n  - name: V\n    type: table\n    groupBy: category\n",
        "has.md": "---\ncategory: x\n---\na",
        "hasnt.md": "---\n---\nb",
      },
    });
    try {
      const r = await v.call("query_base", { vault: "test", path: "p.base" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { items: Array<{ note_path: string; group?: unknown }> };
        const row = d.items.find((i) => i.note_path === "hasnt.md");
        expect(row?.group).toBeNull();
      }
    } finally {
      v.cleanup();
    }
  });
});

describe("base-tools branch coverage: sort variants", () => {
  it("sort accepts bare string entries (not just {property, direction} objects), ASC by default", async () => {
    const v = makeM3Vault({
      files: {
        "p.base": "views:\n  - name: V\n    type: table\n    sort:\n      - note.rank\n",
        "b.md": "---\nrank: 2\n---\nb",
        "a.md": "---\nrank: 1\n---\na",
      },
    });
    try {
      const r = await v.call("query_base", { vault: "test", path: "p.base" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { items: Array<{ note_path: string }> };
        expect(d.items.map((i) => i.note_path)).toEqual(["a.md", "b.md"]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("sort compares numeric values numerically, not lexically", async () => {
    const v = makeM3Vault({
      files: {
        "p.base": "views:\n  - name: V\n    type: table\n    sort:\n      - property: note.rank\n",
        "n10.md": "---\nrank: 10\n---\na",
        "n2.md": "---\nrank: 2\n---\nb",
      },
    });
    try {
      const r = await v.call("query_base", { vault: "test", path: "p.base" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { items: Array<{ note_path: string }> };
        // Numeric compare: 2 before 10. Lexical compare would put "10" before "2".
        expect(d.items.map((i) => i.note_path)).toEqual(["n2.md", "n10.md"]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("sort entries with tied values fall back to a stable (original candidate) order", async () => {
    const v = makeM3Vault({
      files: {
        "p.base": "views:\n  - name: V\n    type: table\n    sort:\n      - property: note.rank\n",
        "a.md": "---\nrank: 1\n---\na",
        "b.md": "---\nrank: 1\n---\nb",
      },
    });
    try {
      const r = await v.call("query_base", { vault: "test", path: "p.base" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { items: Array<{ note_path: string }> };
        // Both rank 1 -> tie -> stable order is walkVault's (alphabetical) candidate order.
        expect(d.items.map((i) => i.note_path)).toEqual(["a.md", "b.md"]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("a malformed sort entry (no usable property) sorts as an empty-string key rather than throwing", async () => {
    const v = makeM3Vault({
      files: {
        "p.base": "views:\n  - name: V\n    type: table\n    sort:\n      - direction: DESC\n",
        "a.md": "---\n---\na",
        "b.md": "---\n---\nb",
      },
    });
    try {
      const r = await v.call("query_base", { vault: "test", path: "p.base" });
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.data as { items: unknown[] }).items.length).toBe(2);
    } finally {
      v.cleanup();
    }
  });
});

describe("base-tools branch coverage: pagination", () => {
  it("a small `limit` yields next_cursor, which fetches the remaining rows", async () => {
    const v = makeM3Vault({
      files: {
        "p.base": "views:\n  - name: V\n    type: table\n    sort:\n      - note.rank\n",
        "a.md": "---\nrank: 1\n---\na",
        "b.md": "---\nrank: 2\n---\nb",
        "c.md": "---\nrank: 3\n---\nc",
      },
    });
    try {
      const page1 = await v.call("query_base", { vault: "test", path: "p.base", limit: 2 });
      expect(page1.ok).toBe(true);
      if (!page1.ok) return;
      const d1 = page1.data as {
        total: number;
        next_cursor?: string;
        items: Array<{ note_path: string }>;
      };
      expect(d1.total).toBe(3);
      expect(d1.items.map((i) => i.note_path)).toEqual(["a.md", "b.md"]);
      expect(d1.next_cursor).toBeDefined();

      const page2 = await v.call("query_base", {
        vault: "test",
        path: "p.base",
        limit: 2,
        cursor: d1.next_cursor,
      });
      expect(page2.ok).toBe(true);
      if (page2.ok) {
        const d2 = page2.data as { next_cursor?: string; items: Array<{ note_path: string }> };
        expect(d2.items.map((i) => i.note_path)).toEqual(["c.md"]);
        expect(d2.next_cursor).toBeUndefined();
      }
    } finally {
      v.cleanup();
    }
  });

  it("a non-numeric cursor falls back to the start of the result set instead of throwing", async () => {
    const v = makeM3Vault({
      files: { "p.base": "views: []\n", "a.md": "---\n---\na" },
    });
    try {
      const r = await v.call("query_base", {
        vault: "test",
        path: "p.base",
        cursor: "not-a-number",
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { items: Array<{ note_path: string }> };
        expect(d.items.map((i) => i.note_path)).toEqual(["a.md"]);
      }
    } finally {
      v.cleanup();
    }
  });
});

describe("base-tools branch coverage: formula evaluation errors", () => {
  it("a JSONLogic formula that throws for a note yields a null column, not a failed query", async () => {
    const v = makeM3Vault({
      files: {
        "p.base":
          'views:\n  - name: V\n    type: table\nformulas:\n  bad:\n    "no-such-op":\n      - 1\n',
        "a.md": "---\n---\na",
      },
    });
    try {
      const r = await v.call("query_base", { vault: "test", path: "p.base" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { items: Array<{ columns: Record<string, unknown> }> };
        expect(d.items[0]?.columns.bad).toBeNull();
      }
    } finally {
      v.cleanup();
    }
  });

  it("a DSL formula that hits an unsupported construct at eval time refuses the whole query", async () => {
    const v = makeM3Vault({
      files: {
        "p.base":
          "views:\n  - name: V\n    type: table\nformulas:\n  bad: note.status.frobnicate()\n",
        "a.md": "---\nstatus: active\n---\na",
      },
    });
    try {
      const r = await v.call("query_base", { vault: "test", path: "p.base" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("unsupported_base_filter");
    } finally {
      v.cleanup();
    }
  });
});
