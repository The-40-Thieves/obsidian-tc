// Retention for the MORGIANA CloudEvents spool (<cacheDir>/<vault>/morgiana-events-<date>.jsonl).
// Like the trace sweep this deletes files, so what it REFUSES to touch matters as much as what it
// prunes: the day file being appended to, symlinks, and anything that is not a spool file.
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MorgianaEmitter, spoolFileName } from "../src/morgiana/emitter";
import { sweepSpool } from "../src/morgiana/spool-sweep";
import { makeTempDir, rmTemp } from "./tmp";

const tmpDirs: string[] = [];
const tmpDir = (): string => {
  const d = makeTempDir("tc-spool-");
  tmpDirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmTemp(d);
    } catch {
      /* a leaked temp dir is cheaper than a teardown failure */
    }
  }
});

let symlinkOk = true;
try {
  const probe = tmpDir();
  symlinkSync(join(probe, "t"), join(probe, "l"), "dir");
} catch {
  symlinkOk = false; // Windows without the privilege to create symlinks
}

const DAY = 86_400_000;
// 2027-01-15T12:00:00Z
const NOW = Date.UTC(2027, 0, 15, 12, 0, 0);
const dateOf = (ageDays: number): string =>
  new Date(NOW - ageDays * DAY).toISOString().slice(0, 10);

/** Write <cacheDir>/<vault>/morgiana-events-<NOW - ageDays>.jsonl of `bytes` bytes, mtime = that
 *  day's end (or `NOW` when ageDays is 0, i.e. the file being written right now). */
function spoolFile(root: string, vault: string, ageDays: number, bytes = 10): string {
  const dir = join(root, vault);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, spoolFileName(dateOf(ageDays)));
  writeFileSync(p, "x".repeat(bytes), "utf8");
  const t = (ageDays === 0 ? NOW : Date.parse(`${dateOf(ageDays)}T23:59:59Z`)) / 1000;
  utimesSync(p, t, t);
  return p;
}
const names = (root: string, vault: string): string[] => readdirSync(join(root, vault)).sort();

describe("sweepSpool age bound", () => {
  it("prunes rotated files older than the window and keeps newer ones", () => {
    const root = tmpDir();
    spoolFile(root, "v1", 45);
    spoolFile(root, "v1", 31);
    spoolFile(root, "v1", 10);
    spoolFile(root, "v2", 90);
    const r = sweepSpool(root, { now: NOW, retentionDays: 30 });
    // NON-EMPTY FLOOR: a sweep that matches nothing reports success forever.
    expect(r.files_age).toBe(3);
    expect(r.files_size).toBe(0);
    expect(r.bytes).toBe(30);
    expect(names(root, "v1")).toEqual([spoolFileName(dateOf(10))]);
    expect(names(root, "v2")).toEqual([]);
  });

  it("never touches today's file, however old its mtime or small the window", () => {
    const root = tmpDir();
    const today = spoolFile(root, "v1", 0);
    const t = (NOW - 400 * DAY) / 1000;
    utimesSync(today, t, t);
    const r = sweepSpool(root, { now: NOW, retentionDays: 1, maxBytes: 1 });
    expect(r.files_age + r.files_size).toBe(0);
    expect(existsSync(today)).toBe(true);
  });

  it("never touches a file written within the last hour, even when its name date is old", () => {
    // The midnight boundary: yesterday's file can still be receiving an event whose time was
    // computed just before UTC midnight.
    const root = tmpDir();
    const p = spoolFile(root, "v1", 40);
    const t = (NOW - 60_000) / 1000;
    utimesSync(p, t, t);
    expect(sweepSpool(root, { now: NOW, retentionDays: 30 }).files_age).toBe(0);
    expect(existsSync(p)).toBe(true);
  });

  it("retentionDays 0 keeps everything by age", () => {
    const root = tmpDir();
    spoolFile(root, "v1", 900);
    expect(sweepSpool(root, { now: NOW, retentionDays: 0 }).files_age).toBe(0);
    expect(names(root, "v1")).toHaveLength(1);
  });

  it("touches only spool-named regular files, never other names or nested dirs", () => {
    const root = tmpDir();
    spoolFile(root, "v1", 90);
    const dir = join(root, "v1");
    for (const n of ["notes.md", "morgiana-events-2020-01-01.jsonl.bak", "morgiana-events-x.jsonl"])
      writeFileSync(join(dir, n), "keep", "utf8");
    mkdirSync(join(dir, spoolFileName("2020-01-01")));
    writeFileSync(join(root, "cache.db"), "keep", "utf8");
    writeFileSync(join(root, spoolFileName("2020-01-01")), "keep", "utf8"); // not inside a vault dir
    expect(sweepSpool(root, { now: NOW, retentionDays: 30 }).files_age).toBe(1);
    expect(names(root, "v1")).toEqual([
      "morgiana-events-2020-01-01.jsonl",
      "morgiana-events-2020-01-01.jsonl.bak",
      "morgiana-events-x.jsonl",
      "notes.md",
    ]);
    expect(existsSync(join(root, "cache.db"))).toBe(true);
    expect(existsSync(join(root, spoolFileName("2020-01-01")))).toBe(true);
  });
});

describe("sweepSpool size bound", () => {
  it("prunes oldest first per vault until under the bound, keeping the active file", () => {
    const root = tmpDir();
    for (const age of [5, 4, 3, 2]) spoolFile(root, "v1", age, 100);
    const today = spoolFile(root, "v1", 0, 100);
    spoolFile(root, "v2", 3, 100); // its own vault: 100 <= 250, untouched
    const r = sweepSpool(root, { now: NOW, retentionDays: 30, maxBytes: 250 });
    expect(r.files_age).toBe(0);
    expect(r.files_size).toBe(3); // 500 -> 200 bytes: the three oldest go
    expect(r.bytes).toBe(300);
    expect(names(root, "v1")).toEqual([spoolFileName(dateOf(2)), spoolFileName(dateOf(0))].sort());
    expect(existsSync(today)).toBe(true);
    expect(names(root, "v2")).toHaveLength(1);
  });

  it("stops at the active file when it alone exceeds the bound", () => {
    const root = tmpDir();
    spoolFile(root, "v1", 2, 100);
    const today = spoolFile(root, "v1", 0, 5000);
    const r = sweepSpool(root, { now: NOW, retentionDays: 30, maxBytes: 10 });
    expect(r.files_size).toBe(1);
    expect(names(root, "v1")).toEqual([spoolFileName(dateOf(0))]);
    expect(existsSync(today)).toBe(true);
  });

  it("absent maxBytes means no size bound", () => {
    const root = tmpDir();
    for (const age of [5, 4, 3]) spoolFile(root, "v1", age, 1_000_000);
    expect(sweepSpool(root, { now: NOW, retentionDays: 30 }).files_size).toBe(0);
  });
});

describe.skipIf(!symlinkOk)("sweepSpool refuses to follow symlinks", () => {
  it("does not delete or follow a symlink named like a spool file", () => {
    const root = tmpDir();
    const outside = tmpDir();
    const secret = join(outside, "precious.txt");
    writeFileSync(secret, "precious", "utf8");
    mkdirSync(join(root, "v1"));
    const link = join(root, "v1", spoolFileName(dateOf(90)));
    symlinkSync(secret, link);
    spoolFile(root, "v1", 80);
    const r = sweepSpool(root, { now: NOW, retentionDays: 30, maxBytes: 1 });
    expect(r.files_age).toBe(1); // the real file only
    expect(existsSync(secret)).toBe(true);
    expect(readFileSync(secret, "utf8")).toBe("precious");
    expect(names(root, "v1")).toEqual([spoolFileName(dateOf(90))]); // the link itself is left alone
  });

  it("does not descend into a symlinked vault directory", () => {
    const root = tmpDir();
    const outside = tmpDir();
    const target = join(outside, spoolFileName("2020-01-01"));
    writeFileSync(target, "outside", "utf8");
    symlinkSync(outside, join(root, "escape"), "dir");
    const r = sweepSpool(root, { now: NOW, retentionDays: 30, maxBytes: 1 });
    expect(r).toEqual({ files_age: 0, files_size: 0, bytes: 0 });
    expect(existsSync(target)).toBe(true);
  });
});

describe("sweepSpool tolerance", () => {
  it("a missing or unreadable spool root is a no-op", () => {
    const root = tmpDir();
    expect(sweepSpool(join(root, "nope"), { now: NOW, retentionDays: 30 })).toEqual({
      files_age: 0,
      files_size: 0,
      bytes: 0,
    });
    writeFileSync(join(root, "afile"), "x");
    expect(sweepSpool(join(root, "afile"), { now: NOW, retentionDays: 30 }).files_age).toBe(0);
  });
});

describe("sweepSpool alongside a live writer", () => {
  it("a writer rotating to a new day file across sweeps loses no events", () => {
    const root = tmpDir();
    spoolFile(root, "v1", 60);
    let clock = NOW;
    const em = new MorgianaEmitter({ cacheDir: root, spool: true, now: () => new Date(clock) });
    em.emit("v1", "tc.maintenance.sweep", { count: 1 });
    sweepSpool(root, { now: NOW, retentionDays: 30 });
    em.emit("v1", "tc.maintenance.sweep", { count: 2 });
    // rotation: the writer moves to tomorrow's file while yesterday's is still being swept
    clock = NOW + DAY;
    em.emit("v1", "tc.maintenance.sweep", { count: 3 });
    sweepSpool(root, { now: NOW + DAY, retentionDays: 1 });
    em.emit("v1", "tc.maintenance.sweep", { count: 4 });
    const lines = (d: string) =>
      readFileSync(join(root, "v1", spoolFileName(d)), "utf8")
        .trim()
        .split("\n");
    expect(names(root, "v1")).not.toContain(spoolFileName(dateOf(60)));
    expect(lines(dateOf(0))).toHaveLength(2); // yesterday's file: inside the 1-day window, kept
    expect(lines(new Date(NOW + DAY).toISOString().slice(0, 10))).toHaveLength(2);
  });

  it("a separate process appending to today's file while sweeps run loses no lines", async () => {
    const root = tmpDir();
    const dir = join(root, "v1");
    mkdirSync(dir);
    const today = new Date().toISOString().slice(0, 10);
    const file = join(dir, spoolFileName(today));
    for (const age of [40, 41, 42]) {
      const p = join(
        dir,
        spoolFileName(new Date(Date.now() - age * DAY).toISOString().slice(0, 10)),
      );
      writeFileSync(p, "old\n");
      const t = (Date.now() - age * DAY) / 1000;
      utimesSync(p, t, t);
    }
    const N = 2000;
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const fs=require("fs");for(let i=0;i<${N};i++)fs.appendFileSync(${JSON.stringify(file)},'{"i":'+i+'}\\n');`,
      ],
      { stdio: "ignore" },
    );
    const exited = new Promise<number | null>((res) => child.on("exit", res));
    let done = false;
    void exited.then(() => {
      done = true;
    });
    let sweeps = 0;
    let pruned = 0;
    while (!done) {
      pruned += sweepSpool(root, { now: Date.now(), retentionDays: 30, maxBytes: 1 }).files_age;
      sweeps += 1;
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(await exited).toBe(0);
    expect(sweeps).toBeGreaterThan(0);
    expect(pruned).toBe(3);
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(N);
  });
});
