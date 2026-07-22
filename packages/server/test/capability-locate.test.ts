// THE-522: locating the obsidian.json registry across platforms. The paths are sourced from
// Obsidian's own help repo (obsidianmd/obsidian-help, "How Obsidian stores data"): macOS
// ~/Library/Application Support/obsidian, Windows %APPDATA%\Obsidian, Linux $XDG_CONFIG_HOME/obsidian
// (or ~/.config/obsidian). Only the Linux path is empirically exercised on CI, so registryCandidates
// is a PURE function of (platform, env, home): every branch is testable here without being on that OS,
// and the auto-locator is only ever a convenience over the always-available explicit-path/scan paths.
import { describe, expect, it } from "vitest";
import { registryCandidates } from "../src/capability/locate";

describe("THE-522 registry path candidates", () => {
  it("uses ~/Library/Application Support on macOS", () => {
    const c = registryCandidates("darwin", {}, "/Users/me");
    expect(c[0]).toBe("/Users/me/Library/Application Support/obsidian/obsidian.json");
  });

  it("uses %APPDATA% on Windows", () => {
    const c = registryCandidates(
      "win32",
      { APPDATA: "C:\\Users\\me\\AppData\\Roaming" },
      "C:\\Users\\me",
    );
    expect(c[0]).toContain("obsidian.json");
    expect(c[0]).toContain("AppData");
  });

  it("prefers $XDG_CONFIG_HOME over ~/.config on Linux", () => {
    const c = registryCandidates("linux", { XDG_CONFIG_HOME: "/home/me/.xdg" }, "/home/me");
    expect(c[0]).toBe("/home/me/.xdg/obsidian/obsidian.json");
  });

  it("falls back to ~/.config on Linux when XDG_CONFIG_HOME is unset", () => {
    const c = registryCandidates("linux", {}, "/home/me");
    expect(c[0]).toBe("/home/me/.config/obsidian/obsidian.json");
  });

  it("includes the Flatpak-relocated path as a Linux candidate", () => {
    // Flatpak/Snap sandboxing moves the config out of ~/.config, so a single hardcoded path misses it.
    const c = registryCandidates("linux", {}, "/home/me");
    expect(c).toContain("/home/me/.var/app/md.obsidian.Obsidian/config/obsidian/obsidian.json");
  });

  it("never throws on an unknown platform, returning no candidates", () => {
    expect(() => registryCandidates("sunos", {}, "/home/me")).not.toThrow();
    expect(registryCandidates("sunos", {}, "/home/me")).toEqual([]);
  });
});
