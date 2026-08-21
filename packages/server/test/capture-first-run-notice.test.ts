// THE-891 item 2 — the one-time capture boot notice. Mirrors plane-opt-in-notice.test.ts's shape
// for the pure formatter, plus marker-file coverage (mkdtempSync, same idiom
// acl-symlink-canonical.test.ts already uses for filesystem-backed tests) since this notice's
// whole point — unlike the plane one — is firing exactly ONCE per install.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureNoticeAlreadyShown,
  captureNoticeMarkerPath,
  emitCaptureFirstRunNotice,
  formatCaptureFirstRunNotice,
  markCaptureNoticeShown,
} from "../src/runtime/capture-first-run-notice";
import { rmTemp } from "./tmp";

describe("formatCaptureFirstRunNotice (THE-891 item 2)", () => {
  it("captureContent on, never shown -> emits, naming location/retention/off-switch", () => {
    const notice = formatCaptureFirstRunNotice({
      captureContent: true,
      alreadyShown: false,
      cacheDir: "/home/user/.obsidian-tc",
      retentionDays: 30,
    });
    expect(notice).not.toBeNull();
    expect(notice).toContain("/home/user/.obsidian-tc");
    expect(notice).toContain("30 days");
    expect(notice).toContain("experiential.captureContent=false");
    expect(notice).toContain("securityProfile");
  });

  it("captureContent on, ALREADY shown -> does not emit (the per-install contract)", () => {
    const notice = formatCaptureFirstRunNotice({
      captureContent: true,
      alreadyShown: true,
      cacheDir: "/home/user/.obsidian-tc",
      retentionDays: 30,
    });
    expect(notice).toBeNull();
  });

  it("captureContent off -> never emits, regardless of alreadyShown (nothing to disclose)", () => {
    expect(
      formatCaptureFirstRunNotice({
        captureContent: false,
        alreadyShown: false,
        cacheDir: "/home/user/.obsidian-tc",
        retentionDays: 30,
      }),
    ).toBeNull();
    expect(
      formatCaptureFirstRunNotice({
        captureContent: false,
        alreadyShown: true,
        cacheDir: "/home/user/.obsidian-tc",
        retentionDays: 30,
      }),
    ).toBeNull();
  });

  it("retentionDays: 0 states unlimited retention explicitly, rather than '0 days'", () => {
    const notice = formatCaptureFirstRunNotice({
      captureContent: true,
      alreadyShown: false,
      cacheDir: "/home/user/.obsidian-tc",
      retentionDays: 0,
    });
    expect(notice).toContain("unlimited");
    expect(notice).not.toContain("0 days");
  });
});

// Tracked temp dirs — removed best-effort in afterEach (PR #627 discipline: an
// untracked mkdtempSync is invisible to teardown and leaks on every run).
const tmpDirs: string[] = [];
function tmpCacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "otc-capture-notice-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmTemp(dir);
    } catch {
      // best-effort: a throwing cleanup fails the suite with every assertion passing
    }
  }
});

describe("the marker mechanism — fires once per cacheDir, not once per boot", () => {
  it("captureNoticeAlreadyShown is false before any marker is written", () => {
    const cacheDir = tmpCacheDir();
    expect(captureNoticeAlreadyShown(cacheDir)).toBe(false);
  });

  it("markCaptureNoticeShown writes the marker so a SECOND check reports true", () => {
    const cacheDir = tmpCacheDir();
    expect(captureNoticeAlreadyShown(cacheDir)).toBe(false);
    markCaptureNoticeShown(cacheDir);
    expect(captureNoticeAlreadyShown(cacheDir)).toBe(true);
  });

  it("the marker lives directly under cacheDir, not in a subdirectory", () => {
    const cacheDir = tmpCacheDir();
    markCaptureNoticeShown(cacheDir);
    const path = captureNoticeMarkerPath(cacheDir);
    expect(path).toBe(join(cacheDir, "capture-notice-shown"));
    expect(() => readFileSync(path, "utf8")).not.toThrow();
  });

  it("a failed write (nonexistent cacheDir) does not throw — best-effort, safe direction is repeat", () => {
    const missing = join(tmpdir(), "otc-capture-notice-does-not-exist", "nested");
    expect(() => markCaptureNoticeShown(missing)).not.toThrow();
    // The marker never landed, so the notice correctly fires again next boot.
    expect(captureNoticeAlreadyShown(missing)).toBe(false);
  });

  it("simulates the boot sequence end to end: fires once, then stays silent", () => {
    const cacheDir = tmpCacheDir();
    const bootOnce = () => {
      const notice = formatCaptureFirstRunNotice({
        captureContent: true,
        alreadyShown: captureNoticeAlreadyShown(cacheDir),
        cacheDir,
        retentionDays: 30,
      });
      if (notice) markCaptureNoticeShown(cacheDir);
      return notice;
    };
    expect(bootOnce()).not.toBeNull(); // first boot: fires
    expect(bootOnce()).toBeNull(); // second boot: silent
    expect(bootOnce()).toBeNull(); // third boot: still silent
  });
});

describe("emitCaptureFirstRunNotice — the side-effecting wrapper server-runtime.ts calls", () => {
  it("writes to stderr once, then stays silent on a second call", () => {
    const cacheDir = tmpCacheDir();
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
      writes.push(String(c));
      return true;
    });
    try {
      emitCaptureFirstRunNotice({ captureContent: true, cacheDir, retentionDays: 30 });
      emitCaptureFirstRunNotice({ captureContent: true, cacheDir, retentionDays: 30 });
      expect(writes).toHaveLength(1);
      expect(writes[0]).toContain(cacheDir);
    } finally {
      spy.mockRestore();
    }
  });

  it("writes nothing when captureContent is off", () => {
    const cacheDir = tmpCacheDir();
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      emitCaptureFirstRunNotice({ captureContent: false, cacheDir, retentionDays: 30 });
      expect(spy).not.toHaveBeenCalled();
      expect(captureNoticeAlreadyShown(cacheDir)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
