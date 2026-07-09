import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { makeTestVault } from "./m1-helpers";

function hashOf(r: ToolResult): string {
  if (r.ok) throw new Error("expected an error result");
  return String((r.error.details as { args_hash?: string }).args_hash);
}

describe("THE-374 snapshot + restore_note", () => {
  it("auto-captures prior state on overwrite and restores it (restore is itself reversible)", async () => {
    const v = makeTestVault({
      files: { "a.md": "V1" },
      snapshots: { enabled: true, retention: 10 },
    });
    try {
      // overwrite a non-empty note -> HITL, and the prior "V1" is captured on the confirmed write
      const input = { vault: "test", path: "a.md", content: "V2", mode: "overwrite" as const };
      const need = await v.call("write_note", input);
      expect(need.ok).toBe(false);
      if (!need.ok) expect(need.error.code).toBe("elicit_required");
      const wtoken = issueElicitToken(v.db, {
        vaultId: "test",
        toolName: "write_note",
        argsHash: hashOf(need),
        caller: "test",
      });
      const wrote = await v.call("write_note", input, { elicitToken: wtoken });
      expect(wrote.ok).toBe(true);
      expect(v.read("a.md")).toBe("V2");

      const list = await v.call("list_snapshots", { vault: "test", path: "a.md" });
      const snaps = list.ok
        ? (list.data as { snapshots: Array<{ id: number; op: string }> }).snapshots
        : [];
      expect(snaps.length).toBe(1);
      expect(snaps[0]?.op).toBe("write_note");
      const snapId = snaps[0]?.id ?? 0;

      const rd = await v.call("read_snapshot", { vault: "test", snapshot_id: snapId });
      if (rd.ok) expect((rd.data as { content: string }).content).toBe("V1");

      const rneed = await v.call("restore_note", {
        vault: "test",
        path: "a.md",
        snapshot_id: snapId,
      });
      expect(rneed.ok).toBe(false);
      if (!rneed.ok) expect(rneed.error.code).toBe("elicit_required");
      const rtoken = issueElicitToken(v.db, {
        vaultId: "test",
        toolName: "restore_note",
        argsHash: hashOf(rneed),
        caller: "test",
      });
      const restored = await v.call(
        "restore_note",
        { vault: "test", path: "a.md", snapshot_id: snapId },
        { elicitToken: rtoken },
      );
      expect(restored.ok).toBe(true);
      expect(v.read("a.md")).toBe("V1");

      // restore snapshotted the current "V2" first, so the forward state is recoverable too
      const list2 = await v.call("list_snapshots", { vault: "test", path: "a.md" });
      const ops = list2.ok
        ? (list2.data as { snapshots: Array<{ op: string }> }).snapshots.map((s) => s.op)
        : [];
      expect(ops).toContain("restore_note");
    } finally {
      v.cleanup();
    }
  });

  it("captures nothing when snapshots are disabled; manual snapshot_note still works", async () => {
    const v = makeTestVault({ files: { "a.md": "hello" } });
    try {
      const ap = await v.call("append_note", { vault: "test", path: "a.md", content: " world" });
      expect(ap.ok).toBe(true);
      const l0 = await v.call("list_snapshots", { vault: "test", path: "a.md" });
      if (l0.ok) expect((l0.data as { total: number }).total).toBe(0);

      const snap = await v.call("snapshot_note", { vault: "test", path: "a.md" });
      expect(snap.ok).toBe(true);
      const l1 = await v.call("list_snapshots", { vault: "test", path: "a.md" });
      if (l1.ok) expect((l1.data as { total: number }).total).toBe(1);
    } finally {
      v.cleanup();
    }
  });

  it("retention keeps the newest N and GCs orphan blobs", async () => {
    const v = makeTestVault({
      files: { "a.md": "s0" },
      snapshots: { enabled: true, retention: 2 },
    });
    try {
      for (const s of ["s1", "s2", "s3"]) {
        await v.call("snapshot_note", { vault: "test", path: "a.md" });
        v.write("a.md", s);
      }
      await v.call("snapshot_note", { vault: "test", path: "a.md" });
      const list = await v.call("list_snapshots", { vault: "test", path: "a.md" });
      if (list.ok) expect((list.data as { total: number }).total).toBe(2);
      const blobs = (
        v.db.prepare("SELECT COUNT(*) AS n FROM snapshot_blobs WHERE vault_id = 'test'").get() as {
          n: number;
        }
      ).n;
      expect(blobs).toBeLessThanOrEqual(2);
    } finally {
      v.cleanup();
    }
  });

  it("restore_note rejects a snapshot id from a different path", async () => {
    const v = makeTestVault({
      files: { "a.md": "A", "b.md": "B" },
      snapshots: { enabled: true, retention: 10 },
    });
    try {
      const sa = await v.call("snapshot_note", { vault: "test", path: "a.md" });
      const aid = sa.ok ? (sa.data as { snapshot_id: number }).snapshot_id : 0;
      const bad = await v.call("restore_note", { vault: "test", path: "b.md", snapshot_id: aid });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });
});
