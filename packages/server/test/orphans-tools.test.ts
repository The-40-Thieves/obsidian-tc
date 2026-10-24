// find_orphans: the flat list (unchanged when group_by is absent) and group_by=folder (Refs #1333).
import { utimesSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTestVault } from "./m1-helpers";

const day = (d: string): Date => new Date(`${d}T00:00:00.000Z`);
const iso = (d: string): string => day(d).toISOString();

// Orphans: index.md and loose.md (root), three daily notes, one archive note. linked.md has an
// inbound link from index.md, so it is not one.
const FILES = {
  "index.md": "[[linked]]",
  "linked.md": "content",
  "loose.md": "nothing",
  "daily/2026-01-01.md": "d1",
  "daily/2026-01-02.md": "d2",
  "daily/2026-01-03.md": "d3",
  "archive/old.md": "old",
};

function vaultWithMtimes(): ReturnType<typeof makeTestVault> {
  const v = makeTestVault({ files: FILES });
  const set = (rel: string, d: string): void => {
    utimesSync(join(v.root, rel), day(d), day(d));
  };
  set("index.md", "2026-02-01");
  set("loose.md", "2026-02-05");
  set("daily/2026-01-01.md", "2026-01-01");
  set("daily/2026-01-02.md", "2026-01-02");
  set("daily/2026-01-03.md", "2026-01-03");
  set("archive/old.md", "2026-03-01");
  return v;
}

const DAILY = { folder: "daily", count: 3, oldest: iso("2026-01-01"), newest: iso("2026-01-03") };
const ROOT = { folder: "/", count: 2, oldest: iso("2026-02-01"), newest: iso("2026-02-05") };
const ARCHIVE = {
  folder: "archive",
  count: 1,
  oldest: iso("2026-03-01"),
  newest: iso("2026-03-01"),
};

describe("find_orphans", () => {
  it("without group_by, the output is the flat list it always was (no groups key)", async () => {
    const v = vaultWithMtimes();
    try {
      const r = await v.call("find_orphans", { vault: "test" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.data as Record<string, unknown>;
      expect(Object.keys(d).sort()).toEqual([
        "next_cursor",
        "orphans",
        "total",
        "truncated",
        "vault",
      ]);
      expect({ ...d, orphans: [...(d.orphans as string[])].sort() }).toEqual({
        vault: "test",
        total: 6,
        truncated: false,
        next_cursor: null,
        orphans: [
          "archive/old.md",
          "daily/2026-01-01.md",
          "daily/2026-01-02.md",
          "daily/2026-01-03.md",
          "index.md",
          "loose.md",
        ],
      });
    } finally {
      v.cleanup();
    }
  });

  it("group_by=folder counts per top-level folder with mtime bounds, root notes under '/', count desc", async () => {
    const v = vaultWithMtimes();
    try {
      const r = await v.call("find_orphans", { vault: "test", group_by: "folder" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect((r.data as { groups: unknown }).groups).toEqual([DAILY, ROOT, ARCHIVE]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("group_by=folder describes the whole result while the page is limited", async () => {
    const v = vaultWithMtimes();
    try {
      const r = await v.call("find_orphans", { vault: "test", group_by: "folder", limit: 2 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.data as { orphans: string[]; total: number; truncated: boolean; groups: unknown };
      expect(d.orphans).toHaveLength(2);
      expect(d.total).toBe(6);
      expect(d.truncated).toBe(true);
      expect(d.groups).toEqual([DAILY, ROOT, ARCHIVE]);
    } finally {
      v.cleanup();
    }
  });

  it("group_by=folder with a folder filter groups only the orphans under it", async () => {
    const v = vaultWithMtimes();
    try {
      const r = await v.call("find_orphans", {
        vault: "test",
        folder: "daily",
        group_by: "folder",
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.data as { groups: unknown }).groups).toEqual([DAILY]);
    } finally {
      v.cleanup();
    }
  });
});
