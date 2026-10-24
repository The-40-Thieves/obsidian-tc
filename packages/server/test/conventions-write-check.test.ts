// The folder conventions check after a note write: warnings name the layer that breaks, a clean write
// carries no `conventions` key, the check fails open, and the caller's read ACL decides which layers
// count. Advisory only: the note is written whatever the check says.
import { describe, expect, it } from "vitest";
import { conventionsChecker } from "../src/mcp/registry/conventions-scope";
import type { CallerContext, ConventionsSink, ToolDefinition } from "../src/mcp/registry/types";
import { CHECKED, expectClean, LEGACY, REQUIRE_TYPE, withVault } from "./conventions-helpers";

/** A conventions sink whose check always throws: the write must still stand. */
const failingSink: ConventionsSink = {
  begin: async () => ({}),
  check: async () => {
    throw new Error("boom");
  },
};

/** The `conventions` field of a successful write's result: undefined when the check reported nothing. */
function fieldOf(r: { ok: boolean; data?: unknown }):
  | {
      warnings?: { code: string; source: string }[];
      file_warnings?: { path: string }[];
    }
  | undefined {
  return r.ok ? (r.data as { conventions?: ReturnType<typeof fieldOf> }).conventions : undefined;
}

describe("write_note conventions", () => {
  it("write_note reports a missing required layer warning and still writes the note", async () => {
    await withVault({ ...CHECKED, files: { "meetings/SCHEMA.md": REQUIRE_TYPE } }, async (v) => {
      const r = await v.call("write_note", {
        vault: "test",
        path: "meetings/m.md",
        content: "x\n",
      });
      expect(r.ok).toBe(true);
      expect(fieldOf(r)?.warnings?.[0]?.code).toBe("missing_required");
      expect(fieldOf(r)?.warnings?.[0]?.source).toBe("meetings/SCHEMA.md");
      expect(v.read("meetings/m.md")).toBe("x\n");
    });
  });

  it("a clean note carries no conventions key", async () => {
    await withVault({ ...CHECKED, files: { "meetings/SCHEMA.md": REQUIRE_TYPE } }, async (v) => {
      const r = await v.call("write_note", {
        vault: "test",
        path: "meetings/m.md",
        content: "---\ntype: meeting\n---\nbody\n",
      });
      expectClean(r);
    });
  });

  it("a caller who cannot read the SCHEMA layer gets no warnings from it", async () => {
    await withVault(
      {
        ...CHECKED,
        centralAcl: true,
        acl: { readPaths: ["open/**"], writePaths: ["open/**"] },
        files: { "SCHEMA.md": REQUIRE_TYPE },
      },
      async (v) => {
        const r = await v.call("write_note", { vault: "test", path: "open/m.md", content: "x\n" });
        expectClean(r);
      },
    );
  });

  it("a pre-existing bad note the write did not change is not reported", async () => {
    await withVault(
      {
        ...CHECKED,
        files: { "meetings/SCHEMA.md": REQUIRE_TYPE, "meetings/old.md": "no frontmatter\n" },
      },
      async (v) => {
        const r = await v.call("write_note", {
          vault: "test",
          path: "meetings/new.md",
          content: "---\ntype: meeting\n---\n",
        });
        expectClean(r);
      },
    );
  });

  it("an internal error in the check fails open: the write succeeds, onInternalError is called, no conventions key", async () => {
    const reported: string[] = [];
    await withVault(
      {
        centralAcl: true,
        files: { "meetings/SCHEMA.md": REQUIRE_TYPE },
        registryOpts: {
          conventions: failingSink,
          onInternalError: (tool: string) => reported.push(tool),
        },
      },
      async (v) => {
        const r = await v.call("write_note", {
          vault: "test",
          path: "meetings/m.md",
          content: "x\n",
        });
        expectClean(r);
        expect(reported).toEqual(["conventions:write_note"]);
        expect(v.read("meetings/m.md")).toBe("x\n");
      },
    );
  });

  it("idempotent replay returns the same conventions field", async () => {
    await withVault({ ...CHECKED, files: { "meetings/SCHEMA.md": REQUIRE_TYPE } }, async (v) => {
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
    });
  });

  it("a SCHEMA.md written then a note in the same folder uses the new rule", async () => {
    await withVault(CHECKED, async (v) => {
      const before = await v.call("write_note", {
        vault: "test",
        path: "meetings/a.md",
        content: "x\n",
      });
      expectClean(before);
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
      expect(fieldOf(after)?.warnings?.[0]?.code).toBe("missing_required");
    });
  });

  it("an abort signal stops the conventions check mid-way and the write stands", async () => {
    const paths = Array.from({ length: 300 }, (_, i) => `meetings/n${i}.md`);
    const files: Record<string, string> = { "meetings/SCHEMA.md": REQUIRE_TYPE };
    for (const p of paths) files[p] = "no frontmatter\n";
    await withVault({ files }, async (v) => {
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
    });
  });

  it("the read ACL: a caller who cannot read a note gets no value from it", async () => {
    await withVault(
      {
        ...CHECKED,
        acl: { readPaths: ["SCHEMA.md", "pub/**"], writePaths: ["secret/**"] },
        files: {
          "SCHEMA.md":
            "---\nconventions:\n  frontmatter:\n    values:\n      status: [a, b]\n---\n",
          "secret/s.md": "---\nstatus: TOPSECRET\n---\nbody\n",
        },
      },
      async (v) => {
        const r = await v.call("append_note", {
          vault: "test",
          path: "secret/s.md",
          content: "more\n",
        });
        expectClean(r);
        expect(JSON.stringify(r)).not.toContain("TOPSECRET");
      },
    );
  });

  it("a clean wiki page carries no conventions key", async () => {
    await withVault(
      { ...CHECKED, wikiFolder: "wiki", files: { "wiki/SCHEMA.md": LEGACY } },
      async (v) => {
        const r = await v.call("write_note", {
          vault: "test",
          path: "wiki/page.md",
          content: "---\nsummary: s\n---\nbody\n",
        });
        expectClean(r);
      },
    );
  });

  it("generated wiki index and log notes are not judged", async () => {
    await withVault(
      { ...CHECKED, wikiFolder: "wiki", files: { "SCHEMA.md": REQUIRE_TYPE } },
      async (v) => {
        for (const path of ["wiki/index.md", "wiki/log.md"]) {
          const r = await v.call("write_note", { vault: "test", path, content: "x\n" });
          expectClean(r);
        }
      },
    );
  });

  it("a clean note under a layer with file warnings carries no conventions key", async () => {
    await withVault(
      {
        ...CHECKED,
        files: {
          "meetings/SCHEMA.md":
            "---\nconventions:\n  frontmatter:\n    required: [type]\n    bogus: 1\n---\n",
        },
      },
      async (v) => {
        const r = await v.call("write_note", {
          vault: "test",
          path: "meetings/m.md",
          content: "---\ntype: meeting\n---\nbody\n",
        });
        expectClean(r);
      },
    );
  });

  it("a broken SCHEMA.md this call wrote reports its file warnings", async () => {
    await withVault({ ...CHECKED }, async (v) => {
      const r = await v.call("write_note", {
        vault: "test",
        path: "meetings/SCHEMA.md",
        content: "---\nconventions:\n  frontmatter:\n    required: [type]\n    bogus: 1\n---\n",
      });
      expect(r.ok).toBe(true);
      expect(fieldOf(r)?.file_warnings?.[0]?.path).toBe("meetings/SCHEMA.md");
    });
  });

  it("the write succeeds when the sink and onInternalError also throws", async () => {
    await withVault(
      {
        centralAcl: true,
        files: { "meetings/SCHEMA.md": REQUIRE_TYPE },
        registryOpts: {
          conventions: failingSink,
          onInternalError: () => {
            throw new Error("reporter down");
          },
        },
      },
      async (v) => {
        const r = await v.call("write_note", {
          vault: "test",
          path: "meetings/m.md",
          content: "x\n",
        });
        expectClean(r);
        expect(v.read("meetings/m.md")).toBe("x\n");
      },
    );
  });

  it("an overflowing conventions field is dropped and the committed write stands", async () => {
    const values = Array.from({ length: 40 }, (_, i) => `value-${"x".repeat(40)}${i}`).join(", ");
    await withVault(
      {
        ...CHECKED,
        maxResponseBytes: 4096,
        files: {
          "m/SCHEMA.md": `---\nconventions:\n  frontmatter:\n    values:\n      status: [${values}]\n---\n`,
        },
      },
      async (v) => {
        const r = await v.call("write_note", {
          vault: "test",
          path: "m/n.md",
          content: "---\nstatus: nope\n---\n",
        });
        expectClean(r);
        expect(v.exists("m/n.md")).toBe(true);
      },
    );
  });

  it("./ // and /./ path spellings are normalised and judged", async () => {
    await withVault({ ...CHECKED, files: { "meetings/SCHEMA.md": REQUIRE_TYPE } }, async (v) => {
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
    });
  });
});
