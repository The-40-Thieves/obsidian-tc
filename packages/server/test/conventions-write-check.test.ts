// The folder conventions check after a note write: warnings name the layer that breaks, a clean write
// carries no `conventions` key, the check fails open, and the caller's read ACL decides which layers
// count. Advisory only: the note is written whatever the check says.
import { describe, expect, it } from "vitest";
import { conventionsChecker } from "../src/mcp/registry/conventions-scope";
import type { CallerContext, ConventionsSink, ToolDefinition } from "../src/mcp/registry/types";
import { makeTestVault } from "./m1-helpers";

const REQUIRE_TYPE = "---\nconventions:\n  frontmatter:\n    required: [type]\n---\n# rules\n";
const LEGACY =
  "---\ntypes:\n  concept:\n    required: [summary]\nproperties:\n  summary: {}\n---\n";
const CHECKED = { centralAcl: true, conventions: true };

describe("write_note conventions", () => {
  it("write_note reports a missing required layer warning and still writes the note", async () => {
    const v = makeTestVault({ ...CHECKED, files: { "meetings/SCHEMA.md": REQUIRE_TYPE } });
    try {
      const r = await v.call("write_note", {
        vault: "test",
        path: "meetings/m.md",
        content: "x\n",
      });
      expect(r.ok).toBe(true);
      const d = (r.ok ? r.data : {}) as {
        conventions?: { warnings?: { code: string; source: string }[] };
      };
      expect(d.conventions?.warnings?.[0]?.code).toBe("missing_required");
      expect(d.conventions?.warnings?.[0]?.source).toBe("meetings/SCHEMA.md");
      expect(v.read("meetings/m.md")).toBe("x\n");
    } finally {
      v.cleanup();
    }
  });

  it("a clean note carries no conventions key", async () => {
    const v = makeTestVault({ ...CHECKED, files: { "meetings/SCHEMA.md": REQUIRE_TYPE } });
    try {
      const r = await v.call("write_note", {
        vault: "test",
        path: "meetings/m.md",
        content: "---\ntype: meeting\n---\nbody\n",
      });
      expect(r.ok).toBe(true);
      expect(r.ok && "conventions" in (r.data as object)).toBe(false);
    } finally {
      v.cleanup();
    }
  });

  it("a caller who cannot read the SCHEMA layer gets no warnings from it", async () => {
    const v = makeTestVault({
      ...CHECKED,
      centralAcl: true,
      acl: { readPaths: ["open/**"], writePaths: ["open/**"] },
      files: { "SCHEMA.md": REQUIRE_TYPE },
    });
    try {
      const r = await v.call("write_note", { vault: "test", path: "open/m.md", content: "x\n" });
      expect(r.ok).toBe(true);
      expect(r.ok && "conventions" in (r.data as object)).toBe(false);
    } finally {
      v.cleanup();
    }
  });

  it("a pre-existing bad note the write did not change is not reported", async () => {
    const v = makeTestVault({
      ...CHECKED,
      files: { "meetings/SCHEMA.md": REQUIRE_TYPE, "meetings/old.md": "no frontmatter\n" },
    });
    try {
      const r = await v.call("write_note", {
        vault: "test",
        path: "meetings/new.md",
        content: "---\ntype: meeting\n---\n",
      });
      expect(r.ok).toBe(true);
      expect(r.ok && "conventions" in (r.data as object)).toBe(false);
    } finally {
      v.cleanup();
    }
  });

  it("an internal error in the check fails open: the write succeeds, onInternalError is called, no conventions key", async () => {
    const reported: string[] = [];
    const failing: ConventionsSink = {
      begin: async () => ({}),
      check: async () => {
        throw new Error("boom");
      },
    };
    const v = makeTestVault({
      centralAcl: true,
      files: { "meetings/SCHEMA.md": REQUIRE_TYPE },
      registryOpts: {
        conventions: failing,
        onInternalError: (tool: string) => reported.push(tool),
      },
    });
    try {
      const r = await v.call("write_note", {
        vault: "test",
        path: "meetings/m.md",
        content: "x\n",
      });
      expect(r.ok).toBe(true);
      expect(r.ok && "conventions" in (r.data as object)).toBe(false);
      expect(reported).toEqual(["conventions:write_note"]);
      expect(v.read("meetings/m.md")).toBe("x\n");
    } finally {
      v.cleanup();
    }
  });

  it("idempotent replay returns the same conventions field", async () => {
    const v = makeTestVault({ ...CHECKED, files: { "meetings/SCHEMA.md": REQUIRE_TYPE } });
    try {
      const input = {
        vault: "test",
        path: "meetings/m.md",
        content: "x\n",
        options: { idempotency_key: "conv-replay-1" },
      };
      const first = await v.call("write_note", input);
      const second = await v.call("write_note", input);
      expect(first.ok && second.ok).toBe(true);
      const field = (r: typeof first) =>
        r.ok ? (r.data as { conventions?: unknown }).conventions : 0;
      expect(field(first)).toBeDefined();
      expect(field(second)).toEqual(field(first));
    } finally {
      v.cleanup();
    }
  });

  it("a SCHEMA.md written then a note in the same folder uses the new rule", async () => {
    const v = makeTestVault(CHECKED);
    try {
      const before = await v.call("write_note", {
        vault: "test",
        path: "meetings/a.md",
        content: "x\n",
      });
      expect(before.ok && "conventions" in (before.data as object)).toBe(false);
      const schema = await v.call("write_note", {
        vault: "test",
        path: "meetings/SCHEMA.md",
        content: REQUIRE_TYPE,
      });
      expect(schema.ok).toBe(true);
      const after = await v.call("write_note", {
        vault: "test",
        path: "meetings/b.md",
        content: "x\n",
      });
      expect(after.ok).toBe(true);
      const d = (after.ok ? after.data : {}) as { conventions?: { warnings?: { code: string }[] } };
      expect(d.conventions?.warnings?.[0]?.code).toBe("missing_required");
    } finally {
      v.cleanup();
    }
  });

  it("an abort signal stops the conventions check mid-way and the write stands", async () => {
    const paths = Array.from({ length: 300 }, (_, i) => `meetings/n${i}.md`);
    const files: Record<string, string> = { "meetings/SCHEMA.md": REQUIRE_TYPE };
    for (const p of paths) files[p] = "no frontmatter\n";
    const v = makeTestVault({ files });
    try {
      // Each read of `aborted` is one of the check's own polls: it must stop after a few, not judge all 300.
      let polls = 0;
      const signal = {
        get aborted() {
          polls += 1;
          return polls > 5;
        },
      } as AbortSignal;
      const ctx = {
        vaultId: "test",
        acl: undefined,
        grantedScopes: new Set(["*"]),
        signal,
      } as unknown as CallerContext;
      const checker = conventionsChecker(v.vaultRegistry);
      const def = {
        name: "append_note",
        pathAcl: () => paths.map((path) => ({ op: "write", path })),
      } as unknown as ToolDefinition;
      const pending = await checker.begin(def, {}, ctx, v.root);
      expect(await checker.check(pending, {}, ctx, v.root, new Set(paths))).toBeUndefined();
      expect(polls).toBeLessThan(paths.length);
      expect(v.read("meetings/n0.md")).toBe("no frontmatter\n");
    } finally {
      v.cleanup();
    }
  });

  it("the read ACL: a caller who cannot read a note gets no value from it", async () => {
    const v = makeTestVault({
      ...CHECKED,
      acl: { readPaths: ["SCHEMA.md", "pub/**"], writePaths: ["secret/**"] },
      files: {
        "SCHEMA.md": "---\nconventions:\n  frontmatter:\n    values:\n      status: [a, b]\n---\n",
        "secret/s.md": "---\nstatus: TOPSECRET\n---\nbody\n",
      },
    });
    try {
      const r = await v.call("append_note", {
        vault: "test",
        path: "secret/s.md",
        content: "more\n",
      });
      expect(r.ok).toBe(true);
      expect(r.ok && "conventions" in (r.data as object)).toBe(false);
      expect(JSON.stringify(r)).not.toContain("TOPSECRET");
    } finally {
      v.cleanup();
    }
  });

  it("a clean wiki page carries no conventions key", async () => {
    const v = makeTestVault({
      ...CHECKED,
      wikiFolder: "wiki",
      files: { "wiki/SCHEMA.md": LEGACY },
    });
    try {
      const r = await v.call("write_note", {
        vault: "test",
        path: "wiki/page.md",
        content: "---\nsummary: s\n---\nbody\n",
      });
      expect(r.ok).toBe(true);
      expect(r.ok && "conventions" in (r.data as object)).toBe(false);
    } finally {
      v.cleanup();
    }
  });

  it("generated wiki index and log notes are not judged", async () => {
    const v = makeTestVault({
      ...CHECKED,
      wikiFolder: "wiki",
      files: { "SCHEMA.md": REQUIRE_TYPE },
    });
    try {
      for (const path of ["wiki/index.md", "wiki/log.md"]) {
        const r = await v.call("write_note", { vault: "test", path, content: "x\n" });
        expect(r.ok).toBe(true);
        expect(r.ok && "conventions" in (r.data as object)).toBe(false);
      }
    } finally {
      v.cleanup();
    }
  });

  it("a clean note under a layer with file warnings carries no conventions key", async () => {
    const v = makeTestVault({
      ...CHECKED,
      files: {
        "meetings/SCHEMA.md":
          "---\nconventions:\n  frontmatter:\n    required: [type]\n    bogus: 1\n---\n",
      },
    });
    try {
      const r = await v.call("write_note", {
        vault: "test",
        path: "meetings/m.md",
        content: "---\ntype: meeting\n---\nbody\n",
      });
      expect(r.ok).toBe(true);
      expect(r.ok && "conventions" in (r.data as object)).toBe(false);
    } finally {
      v.cleanup();
    }
  });

  it("a broken SCHEMA.md this call wrote reports its file warnings", async () => {
    const v = makeTestVault({ ...CHECKED });
    try {
      const r = await v.call("write_note", {
        vault: "test",
        path: "meetings/SCHEMA.md",
        content: "---\nconventions:\n  frontmatter:\n    required: [type]\n    bogus: 1\n---\n",
      });
      expect(r.ok).toBe(true);
      const d = (r.ok ? r.data : {}) as { conventions?: { file_warnings?: { path: string }[] } };
      expect(d.conventions?.file_warnings?.[0]?.path).toBe("meetings/SCHEMA.md");
    } finally {
      v.cleanup();
    }
  });

  it("the write succeeds when the sink and onInternalError also throws", async () => {
    const failing: ConventionsSink = {
      begin: async () => ({}),
      check: async () => {
        throw new Error("boom");
      },
    };
    const v = makeTestVault({
      centralAcl: true,
      files: { "meetings/SCHEMA.md": REQUIRE_TYPE },
      registryOpts: {
        conventions: failing,
        onInternalError: () => {
          throw new Error("reporter down");
        },
      },
    });
    try {
      const r = await v.call("write_note", {
        vault: "test",
        path: "meetings/m.md",
        content: "x\n",
      });
      expect(r.ok).toBe(true);
      expect(r.ok && "conventions" in (r.data as object)).toBe(false);
      expect(v.read("meetings/m.md")).toBe("x\n");
    } finally {
      v.cleanup();
    }
  });

  it("an overflowing conventions field is dropped and the committed write stands", async () => {
    const values = Array.from({ length: 40 }, (_, i) => `value-${"x".repeat(40)}${i}`).join(", ");
    const v = makeTestVault({
      ...CHECKED,
      maxResponseBytes: 4096,
      files: {
        "m/SCHEMA.md": `---\nconventions:\n  frontmatter:\n    values:\n      status: [${values}]\n---\n`,
      },
    });
    try {
      const r = await v.call("write_note", {
        vault: "test",
        path: "m/n.md",
        content: "---\nstatus: nope\n---\n",
      });
      expect(r.ok).toBe(true);
      expect(r.ok && "conventions" in (r.data as object)).toBe(false);
      expect(v.exists("m/n.md")).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("./ // and /./ path spellings are normalised and judged", async () => {
    const v = makeTestVault({ ...CHECKED, files: { "meetings/SCHEMA.md": REQUIRE_TYPE } });
    try {
      const spellings: [string, string][] = [
        ["./meetings/a.md", "meetings/a.md"],
        ["meetings//b.md", "meetings/b.md"],
        ["meetings/./c.md", "meetings/c.md"],
      ];
      for (const [path, rel] of spellings) {
        const r = await v.call("write_note", { vault: "test", path, content: "x\n" });
        const d = (r.ok ? r.data : {}) as {
          path?: string;
          conventions?: { warnings?: { code: string }[] };
        };
        expect(d.path).toBe(rel);
        expect(d.conventions?.warnings?.[0]?.code).toBe("missing_required");
      }
    } finally {
      v.cleanup();
    }
  });
});
