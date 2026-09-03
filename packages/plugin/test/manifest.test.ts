// THE-943: obsidian-tc -> TC Bridge rename. Obsidian's community-directory rule (verified via
// context7 against obsidianmd/obsidian-developer-docs, Reference/Manifest.md and Submit your
// plugin.md, 2026-09-03): a submitted plugin's `id` "must not contain 'obsidian'"; the
// `id`/folder-name pairing is required for local development to load correctly. This suite pins
// the manifest fields the rename must produce so a future edit to manifest.json cannot silently
// reintroduce a directory-blocking id/name or drop the isDesktopOnly/fundingUrl requirements this
// task set.
import { describe, expect, it } from "vitest";
import manifest from "../manifest.json";

describe("packages/plugin/manifest.json — community-directory rules (THE-943)", () => {
  it("id is tc-bridge and contains no 'obsidian' substring", () => {
    expect(manifest.id).toBe("tc-bridge");
    expect(manifest.id.toLowerCase()).not.toContain("obsidian");
  });

  it("name is TC Bridge and contains no 'obsidian' substring", () => {
    expect(manifest.name).toBe("TC Bridge");
    expect(manifest.name.toLowerCase()).not.toContain("obsidian");
  });

  it("description contains no standalone 'Obsidian' word", () => {
    expect(/\bobsidian\b/i.test(manifest.description)).toBe(false);
  });

  it("isDesktopOnly is true", () => {
    expect(manifest.isDesktopOnly).toBe(true);
  });

  it("has no fundingUrl key", () => {
    expect(Object.hasOwn(manifest, "fundingUrl")).toBe(false);
  });

  it("minAppVersion is unchanged (1.7.0)", () => {
    expect(manifest.minAppVersion).toBe("1.7.0");
  });

  it("id matches the artifact naming the release job (build-plugin, publish.yml) produces", () => {
    // The release job zips packages/plugin/dist/{main.js,manifest.json,styles.css} as loose
    // community-store assets (see .github/workflows/publish.yml, build-plugin job) — Obsidian
    // requires a manually-installed plugin's folder to be named after manifest.id, and BRAT reads
    // the id from this same manifest.json to pick the install target. There is only one manifest
    // in this package's normal (non-legacy) build path, so "the folder the release job uses" is
    // this file's own id.
    expect(manifest.id).toBe("tc-bridge");
  });
});
