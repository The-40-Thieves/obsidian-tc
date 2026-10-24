// The folder conventions check after a note write: warnings name the layer that breaks, a clean write
// carries no `conventions` key, the check fails open, and the caller's read ACL decides which layers
// count. Advisory only: the note is written whatever the check says.
import { describe, expect, it } from "vitest";
import { conventionsChecker } from "../src/mcp/registry/conventions-scope";
import type { CallerContext, ConventionsSink } from "../src/mcp/registry/types";
import { makeTestVault } from "./m1-helpers";

const REQUIRE_TYPE = "---\nconventions:\n  frontmatter:\n    required: [type]\n---\n# rules\n";
const CHECKED = { centralAcl: true, registryOpts: { conventions: conventionsChecker() } };

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
      ...conventionsChecker(),
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

  it("an abort signal stops the conventions check and the write stands", async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = {
      vaultId: "test",
      acl: undefined,
      grantedScopes: new Set(["*"]),
      signal: controller.signal,
    } as unknown as CallerContext;
    const checker = conventionsChecker();
    const pending = await checker.begin(
      { name: "write_note", pathAcl: () => [{ op: "write", path: "meetings/m.md" }] } as never,
      { vault: "test", path: "meetings/m.md" },
      ctx,
      "/nonexistent-vault-root",
    );
    await expect(
      checker.check(pending, { path: "meetings/m.md" }, ctx, "/nonexistent-vault-root", new Set()),
    ).resolves.toBeUndefined();
  });
});
