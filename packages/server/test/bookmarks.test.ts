import { describe, expect, it } from "vitest";
import { makeM3Vault } from "./m3-helpers";

describe("Domain 10: Bookmarks", () => {
  it("add_bookmark creates the file, list_bookmarks round-trips, and the call audits", async () => {
    const v = makeM3Vault();
    try {
      const a = await v.call("add_bookmark", {
        vault: "test",
        bookmark: { type: "file", path: "Note.md", title: "Note" },
      });
      expect(a.ok).toBe(true);
      if (a.ok) expect((a.data as { added: boolean }).added).toBe(true);
      expect(v.exists(".obsidian/bookmarks.json")).toBe(true);

      const l = await v.call("list_bookmarks", { vault: "test" });
      expect(l.ok).toBe(true);
      if (l.ok) {
        const d = l.data as { count: number; items: Array<{ type: string; path?: string }> };
        expect(d.count).toBe(1);
        expect(d.items[0]?.path).toBe("Note.md");
      }
      expect(v.events().some((e) => e.tool_name === "add_bookmark" && e.status === "ok")).toBe(
        true,
      );
    } finally {
      v.cleanup();
    }
  });

  it("add_bookmark is idempotent on duplicates unless allow_duplicate is set", async () => {
    const v = makeM3Vault();
    try {
      const bm = { type: "url", url: "https://x.dev", title: "X" };
      await v.call("add_bookmark", { vault: "test", bookmark: bm });
      const dup = await v.call("add_bookmark", { vault: "test", bookmark: bm });
      if (dup.ok) {
        const d = dup.data as { added: boolean; duplicate: boolean; count: number };
        expect(d.added).toBe(false);
        expect(d.duplicate).toBe(true);
        expect(d.count).toBe(1);
      }
      const forced = await v.call("add_bookmark", {
        vault: "test",
        bookmark: bm,
        allow_duplicate: true,
      });
      if (forced.ok) expect((forced.data as { count: number }).count).toBe(2);
    } finally {
      v.cleanup();
    }
  });

  it("add_bookmark nests into a named group, creating the group if absent", async () => {
    const v = makeM3Vault();
    try {
      await v.call("add_bookmark", {
        vault: "test",
        bookmark: { type: "url", url: "https://x.dev" },
        group: "Web",
      });
      const l = await v.call("list_bookmarks", { vault: "test" });
      if (l.ok) {
        const items = (l.data as { items: Array<Record<string, unknown>> }).items;
        const g = items.find((i) => i.type === "group" && i.title === "Web");
        expect(g).toBeDefined();
        const inner = (g?.items as Array<{ url?: string }>) ?? [];
        expect(inner[0]?.url).toBe("https://x.dev");
      }
    } finally {
      v.cleanup();
    }
  });

  it("preserves unknown top-level keys and per-item fields on edit", async () => {
    const v = makeM3Vault({
      files: {
        ".obsidian/bookmarks.json": JSON.stringify(
          { items: [{ type: "file", path: "A.md", ctime: 123 }], customTop: true },
          null,
          "\t",
        ),
      },
    });
    try {
      const a = await v.call("add_bookmark", {
        vault: "test",
        bookmark: { type: "file", path: "B.md" },
      });
      expect(a.ok).toBe(true);
      const raw = JSON.parse(v.read(".obsidian/bookmarks.json")) as {
        customTop?: boolean;
        items: Array<{ path?: string; ctime?: number }>;
      };
      expect(raw.customTop).toBe(true);
      expect(raw.items).toHaveLength(2);
      expect(raw.items[0]?.ctime).toBe(123);
    } finally {
      v.cleanup();
    }
  });

  it("remove_bookmark removes matching items and within a named group", async () => {
    const v = makeM3Vault({
      files: {
        ".obsidian/bookmarks.json": JSON.stringify({
          items: [
            { type: "file", path: "A.md" },
            { type: "url", url: "https://x.dev" },
            { type: "group", title: "G", items: [{ type: "file", path: "A.md" }] },
          ],
        }),
      },
    });
    try {
      // top-level only: removes the loose A.md AND the one inside G (recursive)
      const r = await v.callConfirmed("remove_bookmark", {
        vault: "test",
        match: { type: "file", path: "A.md" },
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.data as { removed: number }).removed).toBe(2);

      const l = await v.call("list_bookmarks", { vault: "test" });
      if (l.ok) expect((l.data as { count: number }).count).toBe(1); // only the url remains
    } finally {
      v.cleanup();
    }
  });

  it("remove_bookmark scoped to a group leaves siblings untouched", async () => {
    const v = makeM3Vault({
      files: {
        ".obsidian/bookmarks.json": JSON.stringify({
          items: [
            { type: "file", path: "A.md" },
            { type: "group", title: "G", items: [{ type: "file", path: "A.md" }] },
          ],
        }),
      },
    });
    try {
      const r = await v.callConfirmed("remove_bookmark", {
        vault: "test",
        match: { type: "file", path: "A.md" },
        group: "G",
      });
      if (r.ok) expect((r.data as { removed: number }).removed).toBe(1);
      const l = await v.call("list_bookmarks", { vault: "test" });
      if (l.ok) expect((l.data as { count: number }).count).toBe(1); // loose A.md still there
    } finally {
      v.cleanup();
    }
  });

  it("an add outside the write whitelist is acl_denied", async () => {
    const v = makeM3Vault({ acl: { writePaths: ["allowed/**"] } });
    try {
      const denied = await v.call("add_bookmark", {
        vault: "test",
        bookmark: { type: "file", path: "Note.md" },
      });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe("acl_denied");
    } finally {
      v.cleanup();
    }
  });
});

describe("Domain 10: Bookmarks — prev_hash CAS (THE-292)", () => {
  it("add_bookmark rejects a stale prev_hash and accepts the current one", async () => {
    const v = makeM3Vault();
    try {
      const first = await v.call("add_bookmark", {
        vault: "test",
        bookmark: { type: "file", path: "A.md", title: "A" },
      });
      expect(first.ok).toBe(true);
      const hash = first.ok ? (first.data as { content_hash: string }).content_hash : "";

      // Stale prev_hash -> concurrent_modification, and B is NOT added.
      const stale = await v.call("add_bookmark", {
        vault: "test",
        bookmark: { type: "file", path: "B.md", title: "B" },
        prev_hash: "deadbeef",
      });
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.error.code).toBe("concurrent_modification");
      const l1 = await v.call("list_bookmarks", { vault: "test" });
      if (l1.ok) expect((l1.data as { count: number }).count).toBe(1);

      // Current prev_hash -> the write proceeds.
      const ok = await v.call("add_bookmark", {
        vault: "test",
        bookmark: { type: "file", path: "B.md", title: "B" },
        prev_hash: hash,
      });
      expect(ok.ok).toBe(true);
      const l2 = await v.call("list_bookmarks", { vault: "test" });
      if (l2.ok) expect((l2.data as { count: number }).count).toBe(2);
    } finally {
      v.cleanup();
    }
  });
});
