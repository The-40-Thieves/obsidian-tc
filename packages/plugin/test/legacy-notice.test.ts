// THE-943: the OLD `obsidian-tc` id gets exactly one more release — a sunset build that shows a
// notice pointing users at TC Bridge, then never updates again (packages/plugin/legacy/). This
// pins the sunset manifest's identity (must stay the OLD id — it exists so already-installed
// users get one final signal, not a second `tc-bridge`) and the notice text pure module.
//
// legacy/main.ts extends Obsidian's `Plugin` (a value the vitest obsidian mock deliberately does
// not export — see test/__mocks__/obsidian.ts), so it cannot be imported here, same as
// src/main.ts. The user-visible message is pulled into legacy/notice.ts, a plain string constant
// with no `obsidian` import, precisely so it stays testable.
import { describe, expect, it } from "vitest";
import legacyManifest from "../legacy/manifest.json";
import { LEGACY_NOTICE_MESSAGE } from "../legacy/notice";

// obsidian-tc's last REAL release before THE-943 renamed the id (packages/plugin/manifest.json's
// version at HEAD~ of this change). A literal, not a read of the current tc-bridge manifest: the
// legacy build is intentionally OUT of tc-bridge's version lockstep (it is not one of
// check-version-coherence.mjs's tracked sources — it must never be, since it ships once and then
// is frozen forever), so anchoring this test to tc-bridge's own ongoing version would make it
// fail on every future unrelated tc-bridge release.
const LAST_REAL_OBSIDIAN_TC_RELEASE = "1.25.0";

describe("packages/plugin/legacy/manifest.json — final release of the old id (THE-943)", () => {
  it("keeps the OLD id and name (this is the sunset build, not a second tc-bridge)", () => {
    expect(legacyManifest.id).toBe("obsidian-tc");
    expect(legacyManifest.name).toBe("Obsidian Turbocharged");
  });

  it("version is bumped exactly one release step past obsidian-tc's last real release", () => {
    const bump = (v: string) => v.split(".").map(Number) as [number, number, number];
    const [lastMajor, lastMinor, lastPatch] = bump(LAST_REAL_OBSIDIAN_TC_RELEASE);
    const [major, minor, patch] = bump(legacyManifest.version);
    const isOnePatchBump = major === lastMajor && minor === lastMinor && patch === lastPatch + 1;
    const isOneMinorBump = major === lastMajor && minor === lastMinor + 1 && patch === 0;
    expect(isOnePatchBump || isOneMinorBump).toBe(true);
  });

  it("minAppVersion is unchanged", () => {
    expect(legacyManifest.minAppVersion).toBe("1.7.0");
  });
});

describe("LEGACY_NOTICE_MESSAGE", () => {
  it("names TC Bridge, the tc-bridge id, and tells the user to disable this plugin", () => {
    expect(LEGACY_NOTICE_MESSAGE).toMatch(/TC Bridge/);
    expect(LEGACY_NOTICE_MESSAGE).toMatch(/tc-bridge/);
    expect(LEGACY_NOTICE_MESSAGE.toLowerCase()).toMatch(/disable/);
  });
});
