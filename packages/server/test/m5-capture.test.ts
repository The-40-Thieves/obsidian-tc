// Domain 21 — Capture / inbox queue, end-to-end through dispatch (THE-181). Covers
// enqueue (SQLite-only, audited), list with keyset pagination, commit (vault write +
// queue lifecycle), every spec error code (invalid_input not-found / already-committed,
// note_exists), the read-only kill-switch, scope enforcement, and ACL on the target.
import { describe, expect, it } from "vitest";
import { makeM5Vault } from "./m5-helpers";

describe("enqueue_capture", () => {
  it("stages content in SQLite (no vault write) and audits the call", async () => {
    const v = makeM5Vault();
    try {
      const r = await v.call(
        "enqueue_capture",
        { vault: "test", content: "a thought", title: "T", tags: ["x", "y"], source: "cli" },
        { now: () => 1000 },
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { capture_id: string; captured_at: number; vault: string };
        expect(d.capture_id).toMatch(/^cap_[a-f0-9]{24}$/);
        expect(d.captured_at).toBe(1000);
      }
      // It is queued, not written to the vault.
      const row = v.db
        .prepare("SELECT title, tags, content, committed_at FROM capture_queue")
        .get() as { title: string; tags: string; content: string; committed_at: number | null };
      expect(row).toMatchObject({
        title: "T",
        tags: "x,y",
        content: "a thought",
        committed_at: null,
      });
      expect(v.events().some((e) => e.tool_name === "enqueue_capture" && e.status === "ok")).toBe(
        true,
      );
    } finally {
      v.cleanup();
    }
  });

  it("requires the write:capture scope", async () => {
    const v = makeM5Vault();
    try {
      const r = await v.call(
        "enqueue_capture",
        { vault: "test", content: "x" },
        { grantedScopes: new Set(["read:capture"]) },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("forbidden");
    } finally {
      v.cleanup();
    }
  });

  it("is blocked by the read-only kill-switch", async () => {
    const v = makeM5Vault({ acl: { readOnly: true } });
    try {
      const r = await v.call("enqueue_capture", { vault: "test", content: "x" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("forbidden");
    } finally {
      v.cleanup();
    }
  });
});

describe("list_capture_queue", () => {
  it("lists pending captures newest-first with keyset pagination", async () => {
    const v = makeM5Vault();
    try {
      for (const [n, c] of [
        [10, "first"],
        [20, "second"],
        [30, "third"],
      ] as const) {
        await v.call("enqueue_capture", { vault: "test", content: c }, { now: () => n });
      }
      const p1 = await v.call("list_capture_queue", { vault: "test", limit: 2 });
      expect(p1.ok).toBe(true);
      if (!p1.ok) return;
      const d1 = p1.data as {
        items: Array<{ content_preview: string }>;
        next_cursor: string | null;
      };
      expect(d1.items.map((i) => i.content_preview)).toEqual(["third", "second"]);
      expect(d1.next_cursor).toBeTruthy();

      const p2 = await v.call("list_capture_queue", {
        vault: "test",
        limit: 2,
        cursor: d1.next_cursor ?? undefined,
      });
      if (!p2.ok) throw new Error("page 2 failed");
      const d2 = p2.data as {
        items: Array<{ content_preview: string }>;
        next_cursor: string | null;
      };
      expect(d2.items.map((i) => i.content_preview)).toEqual(["first"]);
      expect(d2.next_cursor).toBeNull();
    } finally {
      v.cleanup();
    }
  });
});

describe("commit_capture", () => {
  async function enqueue(v: ReturnType<typeof makeM5Vault>): Promise<string> {
    const r = await v.call(
      "enqueue_capture",
      { vault: "test", content: "body text", title: "Note", tags: ["a"] },
      { now: () => 100 },
    );
    if (!r.ok) throw new Error("enqueue failed");
    return (r.data as { capture_id: string }).capture_id;
  }

  it("writes the capture to a vault note (with derived frontmatter) and removes it from the queue", async () => {
    const v = makeM5Vault();
    try {
      const id = await enqueue(v);
      const r = await v.call(
        "commit_capture",
        { vault: "test", capture_id: id, target_path: "inbox/note.md" },
        { now: () => 200 },
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as {
          target_path: string;
          committed_at: number;
          content_hash: string;
          removed_from_queue: boolean;
        };
        expect(d.target_path).toBe("inbox/note.md");
        expect(d.committed_at).toBe(200);
        expect(d.removed_from_queue).toBe(true);
        expect(d.content_hash).toMatch(/^[a-f0-9]{64}$/);
      }
      const note = v.read("inbox/note.md");
      expect(note).toContain("title: Note");
      expect(note).toContain("body text");
      // Default delete_from_queue=true removes the row.
      expect(v.db.prepare("SELECT COUNT(*) AS n FROM capture_queue").get()).toEqual({ n: 0 });
    } finally {
      v.cleanup();
    }
  });

  it("keeps the row and marks it committed when delete_from_queue is false", async () => {
    const v = makeM5Vault();
    try {
      const id = await enqueue(v);
      await v.call(
        "commit_capture",
        { vault: "test", capture_id: id, target_path: "inbox/n.md", delete_from_queue: false },
        { now: () => 200 },
      );
      const pending = await v.call("list_capture_queue", { vault: "test", committed: false });
      const committed = await v.call("list_capture_queue", { vault: "test", committed: true });
      if (!pending.ok || !committed.ok) throw new Error("list failed");
      expect((pending.data as { items: unknown[] }).items).toHaveLength(0);
      expect(
        (committed.data as { items: Array<{ committed_path: string }> }).items[0]?.committed_path,
      ).toBe("inbox/n.md");
    } finally {
      v.cleanup();
    }
  });

  it("rejects an unknown or already-committed capture with invalid_input", async () => {
    const v = makeM5Vault();
    try {
      const missing = await v.call("commit_capture", {
        vault: "test",
        capture_id: "cap_nope",
        target_path: "x.md",
      });
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.error.code).toBe("invalid_input");

      const id = await enqueue(v);
      await v.call("commit_capture", {
        vault: "test",
        capture_id: id,
        target_path: "a.md",
        delete_from_queue: false,
      });
      const again = await v.call("commit_capture", {
        vault: "test",
        capture_id: id,
        target_path: "b.md",
      });
      expect(again.ok).toBe(false);
      if (!again.ok) expect(again.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });

  it("refuses to overwrite an existing note (note_exists)", async () => {
    const v = makeM5Vault({ files: { "inbox/note.md": "existing" } });
    try {
      const id = await enqueue(v);
      const r = await v.call("commit_capture", {
        vault: "test",
        capture_id: id,
        target_path: "inbox/note.md",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("note_exists");
    } finally {
      v.cleanup();
    }
  });

  it("enforces the write ACL on the target path", async () => {
    const v = makeM5Vault({ acl: { writePaths: ["allowed/**"] } });
    try {
      const id = await enqueue(v);
      const r = await v.call("commit_capture", {
        vault: "test",
        capture_id: id,
        target_path: "inbox/note.md",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("acl_denied");
    } finally {
      v.cleanup();
    }
  });
});
