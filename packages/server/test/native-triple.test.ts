import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

// The loader (packages/native/index.js) exports hostTriple()/isMusl() regardless of whether the
// compiled .node is present (they live in the hand-written loader, not the binary), so this test
// validates the musl-detection decision logic on any host — it fakes process.platform/arch and
// process.report and never needs a musl machine or a built addon.
const requireCjs = createRequire(import.meta.url);
const native = requireCjs("@the-40-thieves/obsidian-tc-native") as {
  hostTriple(): string | null;
  isMusl(): boolean;
};

const realPlatform = process.platform;
const realArch = process.arch;
const realGetReport = process.report?.getReport?.bind(process.report);

function fakePlatform(platform: NodeJS.Platform, arch: string): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  Object.defineProperty(process, "arch", { value: arch, configurable: true });
}

function fakeReport(report: unknown): void {
  (process.report as unknown as { getReport: () => unknown }).getReport = () => report;
}

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  Object.defineProperty(process, "arch", { value: realArch, configurable: true });
  if (realGetReport) {
    (process.report as unknown as { getReport: unknown }).getReport = realGetReport;
  }
});

describe("native loader host-triple mapping (musl detection)", () => {
  it("maps non-linux platforms without consulting musl", () => {
    fakePlatform("win32", "x64");
    expect(native.isMusl()).toBe(false);
    expect(native.hostTriple()).toBe("win32-x64-msvc");
    fakePlatform("win32", "arm64");
    expect(native.hostTriple()).toBe("win32-arm64-msvc");
    fakePlatform("darwin", "x64");
    expect(native.hostTriple()).toBe("darwin-x64");
    fakePlatform("darwin", "arm64");
    expect(native.hostTriple()).toBe("darwin-arm64");
  });

  it("selects the -gnu triple on a glibc linux host", () => {
    fakeReport({ header: { glibcVersionRuntime: "2.39" }, sharedObjects: [] });
    fakePlatform("linux", "x64");
    expect(native.isMusl()).toBe(false);
    expect(native.hostTriple()).toBe("linux-x64-gnu");
    fakePlatform("linux", "arm64");
    expect(native.hostTriple()).toBe("linux-arm64-gnu");
  });

  it("selects the -musl triple on an Alpine/musl linux host", () => {
    // The loader probes process.report before /usr/bin/ldd, so faking the report drives detection
    // on every host (a real glibc runner reports glibcVersionRuntime; here we inject musl markers).
    fakeReport({ header: {}, sharedObjects: ["/lib/ld-musl-x86_64.so.1"] });
    fakePlatform("linux", "x64");
    expect(native.isMusl()).toBe(true);
    expect(native.hostTriple()).toBe("linux-x64-musl");
    fakePlatform("linux", "arm64");
    expect(native.hostTriple()).toBe("linux-arm64-musl");
  });

  it("returns null on an unmapped platform", () => {
    fakePlatform("freebsd" as NodeJS.Platform, "x64");
    expect(native.hostTriple()).toBe(null);
  });
});
