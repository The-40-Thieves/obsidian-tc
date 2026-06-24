import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MorgianaEmitter, safeVault } from "../src/morgiana/emitter";

let dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "morg-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("MorgianaEmitter spool (G2.4)", () => {
  it("writes a valid CloudEvents JSONL line to the per-day spool file", () => {
    const cacheDir = tmp();
    const e = new MorgianaEmitter({
      cacheDir,
      spool: true,
      now: () => new Date("2026-06-18T09:00:00.000Z"),
      uuid: () => "fixed-id",
    });
    e.emit("main", "tc.tool.call.completed", {
      tool: "read_note",
      caller_hash: "c0ffee00",
      status: "ok",
      duration_ms: 5,
    });
    const file = join(cacheDir, "main", "morgiana-events-2026-06-18.jsonl");
    const ev = JSON.parse(readFileSync(file, "utf8").trim());
    expect(ev).toMatchObject({
      specversion: "1.0",
      id: "fixed-id",
      source: "obsidian-tc/main",
      type: "tc.tool.call.completed",
      datacontenttype: "application/json",
      time: "2026-06-18T09:00:00.000Z",
    });
    expect(ev.data).toMatchObject({ vault_id: "main", tool: "read_note", status: "ok" });
  });

  it("is fail-soft: a write failure drops the event and calls onDropped, never throws", () => {
    const base = tmp();
    const asFile = join(base, "not-a-dir");
    writeFileSync(asFile, "x"); // a FILE used as cacheDir -> creating a vault subdir fails
    const dropped: Array<[string, string]> = [];
    const e = new MorgianaEmitter({
      cacheDir: asFile,
      spool: true,
      onDropped: (v, r) => dropped.push([v, r]),
    });
    expect(() => e.emit("main", "tc.server.start")).not.toThrow();
    expect(dropped).toEqual([["main", "spool_write_failed"]]);
  });

  it("is a no-op when spool is disabled", () => {
    const cacheDir = tmp();
    new MorgianaEmitter({ cacheDir, spool: false }).emit("main", "tc.server.start");
    expect(existsSync(join(cacheDir, "main"))).toBe(false);
  });

  it("sanitizes the vault id so the spool path stays inside cacheDir (path-safe)", () => {
    const cacheDir = tmp();
    const e = new MorgianaEmitter({
      cacheDir,
      spool: true,
      now: () => new Date("2026-06-18T00:00:00.000Z"),
      uuid: () => "id",
    });
    e.emit("../evil", "tc.server.start");
    const entries = readdirSync(cacheDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toMatch(/[\\/]/); // one contained segment, no path separators
    expect(resolve(cacheDir, entries[0] ?? "").startsWith(resolve(cacheDir))).toBe(true);
  });

  it("maps dot-only vault ids to a safe segment so they cannot escape the cache dir", () => {
    expect(safeVault("..")).toBe("_");
    expect(safeVault(".")).toBe("_");
    expect(safeVault("...")).toBe("_");
    expect(safeVault("")).toBe("_");
    expect(safeVault("ok.vault-1")).toBe("ok.vault-1");
    const cacheDir = tmp();
    new MorgianaEmitter({
      cacheDir,
      spool: true,
      now: () => new Date("2026-06-18T00:00:00.000Z"),
      uuid: () => "id",
    }).emit("..", "tc.server.start");
    const entries = readdirSync(cacheDir);
    expect(entries).toEqual(["_"]);
    expect(resolve(cacheDir, entries[0] ?? "").startsWith(resolve(cacheDir))).toBe(true);
  });
});
