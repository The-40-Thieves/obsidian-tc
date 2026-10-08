// The trace-retention sweep deletes files inside a vault, on a timer, outside any tool dispatch. With
// the legacy `workspace.traceFolder` beneath a configured symlinked folder (`wiki -> open`), the
// directory it validated at boot is the lexical `wiki/...` spelling, so a PERSISTENT retarget of the
// symlink (no race at all) used to make the default-enabled sweep delete an aged same-named
// `.jsonl` in the replacement directory: `raw/traces/...` (immutable) or a sibling directory outside
// the vault. The sweep now carries the registry's folder pins, runs under them, enumerates by the
// pinned name, rechecks the ACL's verdict on the folder, and deletes through `hardDelete`.
//
// Native and OBSIDIAN_TC_FORCE_JS_FALLBACK=1 (ci-server.yml): without the native module a pinned
// trace folder is skipped (nothing deleted), never followed through the live alias.
import {
  existsSync,
  mkdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sweepTraceFiles } from "../src/db/maintenance";
import { provisionCacheDb } from "../src/db/provision";
import type { MorgianaEmitter } from "../src/morgiana/emitter";
import { configureMaintenance } from "../src/runtime/maintenance-wiring";
import { Scheduler } from "../src/scheduler/scheduler";
import { nativeVaultIo } from "../src/vault/notes-io";
import { VaultRegistry } from "../src/vault/registry";
import { resolveTraceDirs } from "../src/workspace/sessions";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const AGED = (NOW - 45 * DAY) / 1000;
const FRESH = (NOW - 1 * DAY) / 1000;

const temps: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const t of temps.splice(0)) rmTemp(t);
});

interface Fixture {
  base: string;
  root: string;
  outside: string;
  reg: VaultRegistry;
  vaults: Array<{ id: string; root: string; workspace: { traceFolder: string } }>;
  /** Resolved once, at "boot", like production: before any retarget. */
  dirs: ReturnType<typeof resolveTraceDirs>;
}

const put = (dir: string, name: string, mtime = AGED): string => {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, '{"ts":1}\n');
  utimesSync(p, mtime, mtime);
  return p;
};

/** `wiki -> open`, traces under `wiki/traces`; an aged trace of the same name in open/, raw/ and a
 *  directory outside the vault. */
function fixture(): Fixture {
  const base = makeTempDir("obtc-maint-pinned-");
  temps.push(base);
  const root = join(base, "vault");
  const outside = join(base, "outside");
  put(join(root, "open", "traces"), "old.jsonl");
  put(join(root, "raw", "traces"), "old.jsonl");
  put(join(outside, "traces"), "old.jsonl");
  symlinkSync(join(root, "open"), join(root, "wiki"));
  const reg = new VaultRegistry([{ id: "v", path: root, wiki: { folder: "wiki" } }]);
  const vaults = [
    { id: "v", root: reg.resolve("v").root, workspace: { traceFolder: "wiki/traces" } },
  ];
  const dirs = resolveTraceDirs(vaults, ".obsidian-tc/traces", reg.folderPins);
  return { base, root, outside, reg, vaults, dirs };
}

const retarget = (root: string, target: string): void => {
  unlinkSync(join(root, "wiki"));
  symlinkSync(target, join(root, "wiki"));
};
const sweep = (f: Fixture, dirs = f.dirs): number =>
  sweepTraceFiles(dirs, {
    now: NOW,
    tracesDays: 30,
  });
const victim = (dir: string): string => join(dir, "traces", "old.jsonl");

describe.skipIf(process.platform === "win32")("the trace sweep under a pinned folder", () => {
  it("control: an aged trace in the pinned folder is pruned (native) or left alone (no native module)", () => {
    const f = fixture();
    const n = sweep(f);
    expect(n).toBe(nativeVaultIo ? 1 : 0);
    expect(existsSync(victim(join(f.root, "open")))).toBe(!nativeVaultIo);
    expect(existsSync(victim(join(f.root, "raw")))).toBe(true);
    expect(existsSync(victim(f.outside))).toBe(true);
  });

  it("a fresh trace in the pinned folder is kept", () => {
    const f = fixture();
    put(join(f.root, "open", "traces"), "new.jsonl", FRESH);
    sweep(f);
    expect(existsSync(join(f.root, "open", "traces", "new.jsonl"))).toBe(true);
  });

  it("wiki retargeted to raw: raw/traces/old.jsonl survives, and so does the pinned original", () => {
    const f = fixture();
    retarget(f.root, join(f.root, "raw"));
    expect(sweep(f)).toBe(0);
    expect(existsSync(victim(join(f.root, "raw")))).toBe(true);
    expect(existsSync(victim(join(f.root, "open")))).toBe(true);
  });

  it("wiki retargeted to a directory OUTSIDE the vault: the victim there survives", () => {
    const f = fixture();
    retarget(f.root, f.outside);
    expect(sweep(f)).toBe(0);
    expect(existsSync(victim(f.outside))).toBe(true);
    expect(existsSync(victim(join(f.root, "open")))).toBe(true);
  });

  it("`open` itself replaced by raw (same name, new identity): raw's trace survives", () => {
    const f = fixture();
    renameSync(join(f.root, "open"), join(f.root, "open-gone"));
    renameSync(join(f.root, "raw"), join(f.root, "open"));
    expect(sweep(f)).toBe(0);
    expect(existsSync(victim(join(f.root, "open")))).toBe(true);
    expect(existsSync(victim(join(f.root, "open-gone")))).toBe(true);
  });

  it("a trace folder that is not under any symlink is pruned as before", () => {
    const f = fixture();
    put(join(f.root, "plain", "traces"), "old.jsonl");
    const plain = [
      { id: "v", root: f.vaults[0]?.root ?? "", workspace: { traceFolder: "plain/traces" } },
    ];
    expect(sweep(f, resolveTraceDirs(plain, ".obsidian-tc/traces", f.reg.folderPins))).toBe(1);
    expect(existsSync(victim(join(f.root, "plain")))).toBe(false);
  });
});

// The same, driven the way production does: configureMaintenance registers the sweep on a scheduler
// and the scheduler runs it. Proves folderPins is threaded from the composition root's dependency.
describe.skipIf(process.platform === "win32")("the scheduled maintenance sweep", () => {
  async function runScheduled(
    f: Fixture,
    pins: boolean,
    beforeFirstTick?: () => void,
  ): Promise<void> {
    vi.useFakeTimers();
    const db = openMemoryDb();
    provisionCacheDb(db);
    const sched = new Scheduler();
    configureMaintenance(sched, {
      cacheDir: join(f.base, "cache"),
      db,
      maintenance: {
        enabled: true,
        intervalMinutes: 1,
        jobsCompleteRetentionDays: 7,
        jobsFailedRetentionDays: 30,
        episodesRetentionDays: 90,
        retrievalsRetentionDays: 365,
        captureQueueRetentionDays: 30,
      },
      retention: { eventLogDays: 30, tracesDays: 30 },
      vaults: f.vaults,
      ...(pins ? { folderPins: f.reg.folderPins } : {}),
      defaultTraceFolder: ".obsidian-tc/traces",
      morgiana: { emit: () => undefined } as unknown as MorgianaEmitter,
      eventVaultId: "v",
      now: () => NOW,
    });
    // configureMaintenance has resolved the trace dirs by now ("boot"); the retarget comes after.
    beforeFirstTick?.();
    sched.start();
    await vi.advanceTimersByTimeAsync(61_000);
    await sched.stop();
  }

  it("with the registry's pins, a persistent retarget to raw deletes nothing there", async () => {
    const f = fixture();
    await runScheduled(f, true, () => retarget(f.root, join(f.root, "raw")));
    expect(existsSync(victim(join(f.root, "raw")))).toBe(true);
    expect(existsSync(victim(join(f.root, "open")))).toBe(true);
  });

  it("with the registry's pins and no retarget, the pinned folder is swept (native)", async () => {
    const f = fixture();
    await runScheduled(f, true);
    expect(existsSync(victim(join(f.root, "open")))).toBe(!nativeVaultIo);
    expect(existsSync(victim(join(f.root, "raw")))).toBe(true);
  });
});
