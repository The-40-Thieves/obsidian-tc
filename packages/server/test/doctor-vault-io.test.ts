// vault.io doctor check: which backend note reads run through. The native addon closes the
// intermediate-directory symlink-swap race on Unix; the pure-JS fallback closes it on Linux (the
// opened descriptor's path is checked via procfs) and is best-effort on macOS and Windows.
import { describe, expect, it } from "vitest";
import { vaultIoCheck } from "../src/doctor/vault-io";

const ctx = { serverVersion: "1.33.1" };

describe("vault.io", () => {
  it("is ok on the native addon, whatever the platform", async () => {
    const r = await vaultIoCheck({ nativeLoaded: true, platform: "darwin" }).run(ctx);
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("native");
    expect(r.issues).toBeUndefined();
  });

  it("is ok on pure-JS linux and names the procfs descriptor check", async () => {
    const r = await vaultIoCheck({ nativeLoaded: false, platform: "linux" }).run(ctx);
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("/proc/self/fd");
    expect(r.issues).toBeUndefined();
  });

  it("warns on pure-JS darwin: best-effort against a symlink swap, native closes it", async () => {
    const r = await vaultIoCheck({ nativeLoaded: false, platform: "darwin" }).run(ctx);
    expect(r.status).toBe("warning");
    expect(r.summary).toContain("best-effort");
    expect(r.issues?.join(" ")).toMatch(/symlink swap/);
    expect(r.remediation).toMatch(/native addon/);
    expect(r.remediation).toMatch(/OBSIDIAN_TC_FORCE_JS_FALLBACK/);
  });

  it("warns on pure-JS win32: best-effort, and says the native path does not exist there", async () => {
    const r = await vaultIoCheck({ nativeLoaded: false, platform: "win32" }).run(ctx);
    expect(r.status).toBe("warning");
    expect(r.summary).toContain("best-effort");
    expect(r.issues?.join(" ")).toMatch(/symlink swap/);
    expect(r.remediation).toMatch(/Windows/);
    expect(r.remediation).not.toMatch(/install the native addon/);
  });
});
