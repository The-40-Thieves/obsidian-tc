import { describe, expect, it } from "vitest";
import { globMatch, isDefaultDenied } from "../src/acl";

// café composed (NFC, U+00E9) vs decomposed (NFD, e + U+0301). On macOS the on-disk path is NFD;
// a glob/config authored elsewhere is NFC.
const NFC = "café";
const NFD = "café";

describe("THE-272 ACL Unicode normalization", () => {
  it("matches a glob regardless of the path's normalization form", () => {
    expect(NFC).not.toBe(NFD); // genuinely different byte sequences
    expect(globMatch(`${NFC}/**`, `${NFD}/note.md`)).toBe(true); // NFD path vs NFC glob
    expect(globMatch(`${NFD}/**`, `${NFC}/note.md`)).toBe(true); // NFC path vs NFD glob
    expect(globMatch(`${NFC}/note.md`, `${NFD}/note.md`)).toBe(true);
  });

  it("does not over-match an unrelated path", () => {
    expect(globMatch(`${NFC}/**`, "other/note.md")).toBe(false);
  });

  it("default-deny roots stay denied and unrelated accented paths are not denied", () => {
    expect(isDefaultDenied(".obsidian/plugins/x/data.json")).toBe(true);
    expect(isDefaultDenied(`${NFD}/x`)).toBe(false);
  });
});
