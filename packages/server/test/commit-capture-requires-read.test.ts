// commit_capture writes a queued capture's body into a vault note, so it needs the same read that
// list_capture_queue needs: the capture read scope AND the folder read ACL on the capture's notes.
// A caller that may write captures but not read them must be refused before anything is written
// and the capture stays queued. A missing capture and a capture the folder ACL hides get identical
// refusals, and a caller holding both scopes still commits.
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { type M5Vault, makeM5Vault } from "./m5-helpers";

const V = "test";
const WRITE_ONLY = new Set(["write:capture"]);
const READ_AND_WRITE = new Set(["read:capture", "write:capture"]);

async function enqueue(v: M5Vault, hint?: string): Promise<string> {
  const r = await v.call("enqueue_capture", {
    vault: V,
    content: "captured body",
    ...(hint ? { target_path_hint: hint } : {}),
  });
  if (!r.ok) throw new Error(`enqueue_capture failed: ${JSON.stringify(r.error)}`);
  return (r.data as { capture_id: string }).capture_id;
}

/** The error of a failed call, with every occurrence of `id` neutralised so two calls that differ
 *  only in WHICH id the caller sent compare byte for byte. */
function errorOf(r: ToolResult, id: string): string {
  if (r.ok) throw new Error(`expected a failure, got ${JSON.stringify(r.data)}`);
  return JSON.stringify(r.error).split(id).join("<id>");
}

describe("commit_capture needs the capture read scope", () => {
  it("a caller with write:capture but not read:capture is refused and the capture stays queued", async () => {
    const v = makeM5Vault();
    try {
      const id = await enqueue(v, "pub/note.md");
      const r = await v.call(
        "commit_capture",
        { vault: V, capture_id: id, target_path: "out/note.md" },
        { grantedScopes: WRITE_ONLY },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("forbidden");
      expect(v.exists("out/note.md")).toBe(false);
      expect(v.db.prepare("SELECT committed_at FROM capture_queue WHERE id = ?").get(id)).toEqual({
        committed_at: null,
      });
    } finally {
      v.cleanup();
    }
  });

  it("a hidden capture and a nonexistent one get byte-identical refusals", async () => {
    const v = makeM5Vault({ acl: { readPaths: ["public/**"] } });
    try {
      const hidden = await enqueue(v, "secret/note.md");
      const ghost = "cap_000000000000000000000000";
      const real = await v.call(
        "commit_capture",
        { vault: V, capture_id: hidden, target_path: "out/n.md" },
        { grantedScopes: READ_AND_WRITE },
      );
      const missing = await v.call(
        "commit_capture",
        { vault: V, capture_id: ghost, target_path: "out/n.md" },
        { grantedScopes: READ_AND_WRITE },
      );
      expect(errorOf(real, hidden)).toBe(errorOf(missing, ghost));
      expect(v.exists("out/n.md")).toBe(false);
    } finally {
      v.cleanup();
    }
  });

  it("a caller holding read:capture and write:capture still commits the capture", async () => {
    const v = makeM5Vault();
    try {
      const id = await enqueue(v, "pub/note.md");
      const r = await v.call(
        "commit_capture",
        { vault: V, capture_id: id, target_path: "out/note.md" },
        { grantedScopes: READ_AND_WRITE },
      );
      expect(r.ok).toBe(true);
      expect(v.exists("out/note.md")).toBe(true);
    } finally {
      v.cleanup();
    }
  });
});
