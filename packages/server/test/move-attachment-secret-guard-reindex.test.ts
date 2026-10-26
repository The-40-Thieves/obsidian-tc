// move_attachment's destination is a caller-chosen path, so it gets the same secret-shaped
// refusal move_note / copy_note / write_attachment give it, and the referencing notes it rewrites
// are reindexed the way move_note reindexes its backlink rewrites.
//
// The secret is assembled at runtime (same house rule as memory-defense-remaining-writers.test.ts),
// so no literal in source matches a SECRET_PATTERNS regex.

import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { makeM3Vault } from "./m3-helpers";

function fakeOpenAiKey(): string {
  return ["sk", "-", "Q7w8E9r0T1y2U3i4O5p6A7s8D9f0G1h2"].join("");
}

function errOf(r: ToolResult): { code: string } {
  if (r.ok) throw new Error("expected an error result");
  return r.error;
}

const BLOCK = () => ({ mode: "block" as const, pii: true });

describe("move_attachment refuses a secret-shaped destination path", () => {
  it("refuses with secret_detected and leaves the attachment in place (no references)", async () => {
    const secret = fakeOpenAiKey();
    const v = makeM3Vault({ files: { "probe/pic.png": "x" }, memoryDefense: BLOCK });
    try {
      const r = await v.call("move_attachment", {
        vault: "test",
        from: "probe/pic.png",
        to: `probe/${secret}.png`,
      });
      expect(errOf(r).code).toBe("secret_detected");
      expect(v.read("probe/pic.png")).toBe("x");
      expect(v.exists(`probe/${secret}.png`)).toBe(false);
    } finally {
      v.cleanup();
    }
  });

  it("refuses with secret_detected when update_references is false", async () => {
    const secret = fakeOpenAiKey();
    const v = makeM3Vault({ files: { "probe/pic.png": "x" }, memoryDefense: BLOCK });
    try {
      const r = await v.call("move_attachment", {
        vault: "test",
        from: "probe/pic.png",
        to: `probe/${secret}.png`,
        update_references: false,
      });
      expect(errOf(r).code).toBe("secret_detected");
      expect(v.read("probe/pic.png")).toBe("x");
      expect(v.exists(`probe/${secret}.png`)).toBe(false);
    } finally {
      v.cleanup();
    }
  });
});

describe("move_attachment reindexes each note it rewrites", () => {
  it("calls reindex with the path and rewritten text of every referencing note", async () => {
    const calls: Array<{ vaultId: string; path: string; content: string }> = [];
    const v = makeM3Vault({
      files: {
        "pic.png": "x",
        "linker.md": "see ![[pic.png]] and [[pic.png]]\n",
      },
      reindex: (vaultId, path, content) => calls.push({ vaultId, path, content }),
    });
    try {
      const r = await v.call("move_attachment", {
        vault: "test",
        from: "pic.png",
        to: "moved.png",
      });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(v.read("linker.md")).toBe("see ![[moved.png]] and [[moved.png]]\n");
      expect(calls).toEqual([
        { vaultId: "test", path: "linker.md", content: "see ![[moved.png]] and [[moved.png]]\n" },
      ]);
    } finally {
      v.cleanup();
    }
  });
});
