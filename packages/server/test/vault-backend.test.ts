import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { indexNote, indexVault } from "../src/search/indexer";
import { ensureVecChunks } from "../src/search/vec";
import { FilesystemBackend } from "../src/vault/backend";
import { assertLive, resolveMode } from "../src/vault/mode";
import { openMemoryDb } from "./helpers";

function freshDb(): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  return db;
}
function tmpVault(): string {
  return mkdtempSync(join(tmpdir(), "obtc-backend-"));
}

describe("resolveMode", () => {
  it("explicit live/headless win over the probe", () => {
    expect(resolveMode({ mode: "live" }, false)).toBe("live");
    expect(resolveMode({ mode: "headless", restApiUrl: "http://x" }, true)).toBe("headless");
  });
  it("auto/absent is live only when REST is configured AND reachable", () => {
    const rest = { mode: "auto", restApiUrl: "http://127.0.0.1:27123" } as const;
    expect(resolveMode(rest, true)).toBe("live");
    expect(resolveMode(rest, false)).toBe("headless");
    expect(resolveMode({ mode: "auto" }, true)).toBe("headless"); // reachable but no endpoint
    expect(resolveMode({}, true)).toBe("headless"); // absent mode == auto
  });
});

describe("assertLive", () => {
  it("is a no-op in live mode", () => {
    expect(() => assertLive("live")).not.toThrow();
    expect(() => assertLive("live", "execute_command")).not.toThrow();
  });
  it("throws a typed requires_live_obsidian in headless mode", () => {
    try {
      assertLive("headless", "execute_command");
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as { code: string; details?: { tool?: string } };
      expect(err.code).toBe("requires_live_obsidian");
      expect(err.details?.tool).toBe("execute_command");
    }
  });
});

describe("FilesystemBackend", () => {
  it("writes atomically and reads back; exists / list / walk / delete behave", async () => {
    const root = tmpVault();
    try {
      const be = new FilesystemBackend(root);
      await be.write("notes/a.md", "# A\n");
      expect(await be.read("notes/a.md")).toBe("# A\n");
      expect(await be.exists("notes/a.md")).toBe(true);
      expect(await be.exists("missing.md")).toBe(false);

      await be.write("b.md", "B");
      expect((await be.list()).sort()).toEqual(["b.md", "notes"]);
      expect((await be.walk({ extensions: [".md"] })).map((f) => f.path)).toEqual([
        "b.md",
        "notes/a.md",
      ]);

      await be.delete("b.md");
      expect(await be.exists("b.md")).toBe(false);
      expect(existsSync(join(root, ".trash", "b.md"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("404s a missing read and blocks path traversal", async () => {
    const root = tmpVault();
    try {
      const be = new FilesystemBackend(root);
      await expect(be.read("nope.md")).rejects.toMatchObject({ code: "note_not_found" });
      await expect(be.write("../escape.md", "x")).rejects.toMatchObject({ code: "path_invalid" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fires the index-on-write seam on write and delete", async () => {
    const root = tmpVault();
    try {
      const onWrite = vi.fn();
      const onDelete = vi.fn();
      const be = new FilesystemBackend(root, { onWrite, onDelete });
      await be.write("x.md", "hello");
      expect(onWrite).toHaveBeenCalledWith("x.md", "hello");
      await be.delete("x.md");
      expect(onDelete).toHaveBeenCalledWith("x.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Tier-3 degrade (openBridge headless)", () => {
  it("openBridge throws requires_live_obsidian when the vault mode is headless", async () => {
    const { openBridge, openCompanionBridge } = await import("../src/tools/m4/shared");
    // assertLive runs before any capability/bridge work, so a bare deps with mode=headless
    // is enough to exercise the degrade.
    const deps = { mode: () => "headless" as const } as unknown as Parameters<typeof openBridge>[0];
    expect(() => openBridge(deps, "v1", "tasks")).toThrow(/live Obsidian/);
    expect(() => openCompanionBridge(deps, "v1")).toThrow(/live Obsidian/);
    try {
      openBridge(deps, "v1", "tasks");
    } catch (e) {
      expect((e as { code: string }).code).toBe("requires_live_obsidian");
    }
  });
});

describe("index-on-write + boot reconcile (mechanism)", () => {
  const provider = fakeEmbeddingProvider({ dimensions: 16 });
  const chunkCount = (db: Database, path: string): number =>
    (
      db
        .prepare("SELECT COUNT(*) AS n FROM chunks WHERE vault_id = ? AND path = ?")
        .get("v1", path) as { n: number }
    ).n;

  it("indexNote upserts a note's chunks; re-running on new content re-embeds; empty content prunes", async () => {
    const db = freshDb();
    const hasVec = ensureVecChunks(db, provider.dimensions, { now: () => 0 });
    const r1 = await indexNote(db, provider, "v1", "a.md", "# A\n\nfirst body", hasVec, () => 1);
    expect(r1.upserted).toBeGreaterThan(0);
    expect(chunkCount(db, "a.md")).toBeGreaterThan(0);

    const before = db
      .prepare("SELECT content_hash FROM chunks WHERE vault_id = ? AND path = ?")
      .get("v1", "a.md") as { content_hash: string };
    await indexNote(db, provider, "v1", "a.md", "# A\n\nrewritten body", hasVec, () => 2);
    const after = db
      .prepare("SELECT content_hash FROM chunks WHERE vault_id = ? AND path = ?")
      .get("v1", "a.md") as { content_hash: string };
    expect(after.content_hash).not.toBe(before.content_hash);

    // deindex == empty-content reindex: no chunks left for the path (no embedding call).
    const del = await indexNote(db, provider, "v1", "a.md", "", hasVec, () => 3);
    expect(del.deleted).toBeGreaterThan(0);
    expect(chunkCount(db, "a.md")).toBe(0);
  });

  it("boot reconcile (indexVault) picks up an out-of-band file written while down", async () => {
    const db = freshDb();
    const root = tmpVault();
    try {
      // A note appears on disk without going through a tool (git pull / external editor).
      mkdirSync(join(root, "notes"));
      writeFileSync(join(root, "notes", "external.md"), "# External\n\ncontent added offline");
      const stats = await indexVault({
        db,
        provider,
        vaultId: "v1",
        root,
        isReadable: () => true,
        now: () => 1,
      });
      expect(stats.notes_indexed).toBeGreaterThan(0);
      expect(chunkCount(db, "notes/external.md")).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
