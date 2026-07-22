// THE-522: plugin manifest parsing. The manifest is a DOCUMENTED contract
// (docs.obsidian.md/Reference/Manifest) but there is no published JSON Schema, and the files on
// disk are written by third parties — BRAT installs, dev builds, hand edits. So the parser is
// deliberately defensive: a malformed manifest degrades to a typed "unreadable" result naming the
// path, it never throws and never aborts a whole-vault scan.
//
// The one non-obvious rule the spec pins down: `id` SHOULD equal the containing folder name because
// Obsidian's installer names the folder after the id. A mismatch is a legitimate signal of a
// sideloaded/dev plugin — a WARNING, not an error. We surface it rather than swallow it.
import { describe, expect, it } from "vitest";
import { parseManifest } from "../src/capability/manifest";

describe("THE-522 plugin manifest parsing", () => {
  const valid = {
    id: "obsidian-local-rest-api",
    name: "Local REST API",
    version: "3.2.0",
    minAppVersion: "1.0.0",
    author: "Adam Coddington",
    description: "Get, change or otherwise interact with your notes over a REST API.",
    isDesktopOnly: false,
  };

  it("parses a well-formed manifest into a typed plugin record", () => {
    const r = parseManifest("obsidian-local-rest-api", JSON.stringify(valid));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plugin.id).toBe("obsidian-local-rest-api");
    expect(r.plugin.version).toBe("3.2.0");
    expect(r.plugin.isDesktopOnly).toBe(false);
    expect(r.plugin.folderIdMismatch).toBe(false);
  });

  it("flags a folder/id mismatch as a warning, not a failure", () => {
    // A BRAT or dev install: the folder is the repo name, the manifest id is the real plugin id.
    const r = parseManifest("some-dev-folder", JSON.stringify(valid));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plugin.folderIdMismatch).toBe(true);
    expect(r.plugin.id).toBe("obsidian-local-rest-api"); // the manifest id wins, not the folder
  });

  it("accepts fundingUrl as a plain string", () => {
    const r = parseManifest(
      "x",
      JSON.stringify({ ...valid, id: "x", fundingUrl: "https://ko-fi.com/x" }),
    );
    expect(r.ok).toBe(true);
  });

  it("accepts fundingUrl as an object map", () => {
    const r = parseManifest(
      "x",
      JSON.stringify({
        ...valid,
        id: "x",
        fundingUrl: { "Buy me a coffee": "https://ko-fi.com/x" },
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("degrades to an unreadable result on invalid JSON, naming the folder", () => {
    const r = parseManifest("broken-plugin", "{ not valid json");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.folder).toBe("broken-plugin");
    expect(r.reason).toMatch(/json/i);
  });

  it("degrades to unreadable when a load-bearing field (version) is missing rather than throwing", () => {
    const { version, ...noVersion } = valid;
    const r = parseManifest("obsidian-local-rest-api", JSON.stringify(noVersion));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/version/i);
  });

  // Empirical correction (real vault, 2026-07-22): the docs mark author/minAppVersion/description
  // "required", but hugely popular plugins ship without them and Obsidian loads them fine. Treating
  // the docs' "required" as a hard gate reported obsidian-git (millions of installs) as UNREADABLE.
  // Only id/name/version are truly load-bearing for detection; the rest degrade to a fallback.
  it("accepts a real manifest missing minAppVersion (obsidian-git shape)", () => {
    const r = parseManifest(
      "obsidian-git",
      JSON.stringify({
        id: "obsidian-git",
        name: "Git",
        version: "2.38.6",
        author: "Vinzent",
        description: "Integrate Git version control.",
        isDesktopOnly: false,
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plugin.minAppVersion).toBe(""); // absent -> empty, not a rejection
  });

  it("accepts a real manifest missing author (obsidian-mind-map shape)", () => {
    const r = parseManifest(
      "obsidian-mind-map",
      JSON.stringify({
        id: "obsidian-mind-map",
        name: "Mind Map",
        version: "1.1.0",
        description: "Preview notes as mind maps",
        isDesktopOnly: false,
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plugin.author).toBe("");
  });

  it("does not throw on any string input (fuzz the contract boundary)", () => {
    for (const bad of ["", "null", "[]", "42", '"a string"', "{}", '{"id":123}']) {
      expect(() => parseManifest("f", bad)).not.toThrow();
      expect(parseManifest("f", bad).ok).toBe(false);
    }
  });
});
