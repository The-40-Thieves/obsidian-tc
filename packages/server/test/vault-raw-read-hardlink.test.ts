// A hard link is a second directory entry for the same inode: realpath and the folder ACL cannot see
// it, so every read of a vault file must go through the opened-fd guard (readNote / readFileChecked,
// vault/notes-io.ts) that refuses nlink > 1. These are the sites that used to read a vault file with
// a raw readFileSync (or an fd read without the link-count check). Each is a vault-content file
// (.obsidian config, a session trace, a reflection) that a hard link can point at an ACL-denied
// private note. Runs in the native-loaded CI step too: the native safe-open and the JS fallback
// refuse a hard link by different code.

import { linkSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { discoverPlugins } from "../src/capability/discovery";
import { resolveAttachmentFolder } from "../src/formats/attachments";
import { readJsonFile } from "../src/formats/json-config";
import { resolvePeriodicConfig } from "../src/formats/periodic";
import { digestUnder } from "../src/provenance/digest";
import { DIGEST_UNHASHABLE } from "../src/provenance/types";
import { readTrace } from "../src/workspace/sessions";
import { makeTempDir, rmTemp } from "./tmp";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmTemp(r);
});

function vault(): string {
  const root = makeTempDir("obtc-rawread-hl-");
  roots.push(root);
  for (const d of ["private", ".obsidian", "memory"]) mkdirSync(join(root, d), { recursive: true });
  return root;
}

/** Write `body` as an ACL-denied private note and hard-link it to `rel` (vault-relative). */
function plantHardLink(root: string, body: string, rel: string): string {
  const secret = join(root, "private", `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(secret, body);
  const target = join(root, rel);
  mkdirSync(join(target, ".."), { recursive: true });
  linkSync(secret, target);
  return target;
}

describe("formats/json-config readJsonFile (bookmarks.json, workspaces.json)", () => {
  it("refuses a config file that is a hard link", () => {
    const root = vault();
    const abs = plantHardLink(root, '{"items":[{"title":"SECRET-BOOKMARK"}]}', ".obsidian/bm.json");
    expect(() => readJsonFile(abs, { items: [] })).toThrow(/hard-link|inode|safe open refused/i);
  });
  it("still reads a normal config file and a missing one", () => {
    const root = vault();
    const abs = join(root, ".obsidian", "bm.json");
    writeFileSync(abs, '{"items":[1]}');
    expect(readJsonFile<{ items: number[] }>(abs, { items: [] }).data.items).toEqual([1]);
    expect(readJsonFile(join(root, ".obsidian", "none.json"), { items: [] }).exists).toBe(false);
  });
});

describe("formats/periodic resolvePeriodicConfig (daily-notes.json)", () => {
  it("ignores a daily-notes.json that is a hard link", () => {
    const root = vault();
    plantHardLink(
      root,
      '{"folder":"SECRETFOLDER","format":"[SECRET]"}',
      ".obsidian/daily-notes.json",
    );
    const { config, source } = resolvePeriodicConfig(root, "daily");
    expect(source).toBe("default");
    expect(config.folder).toBe("");
  });
  it("still honours a normal daily-notes.json", () => {
    const root = vault();
    writeFileSync(join(root, ".obsidian", "daily-notes.json"), '{"folder":"journal"}');
    const { config, source } = resolvePeriodicConfig(root, "daily");
    expect(source).toBe("daily-notes");
    expect(config.folder).toBe("journal");
  });
});

describe("formats/attachments resolveAttachmentFolder (app.json)", () => {
  it("ignores an app.json that is a hard link", () => {
    const root = vault();
    plantHardLink(root, '{"attachmentFolderPath":"SECRETDIR"}', ".obsidian/app.json");
    expect(resolveAttachmentFolder(root)).toBe("");
  });
  it("still honours a normal app.json", () => {
    const root = vault();
    writeFileSync(join(root, ".obsidian", "app.json"), '{"attachmentFolderPath":"assets"}');
    expect(resolveAttachmentFolder(root)).toBe("assets");
  });
});

describe("capability/discovery discoverPlugins (manifest.json, community-plugins.json)", () => {
  const manifest = (id: string) =>
    JSON.stringify({ id, name: `SECRETNAME-${id}`, version: "1.0.0", description: "SECRETDESC" });

  // looksLikeConfigDir wants a marker file; without one discoverPlugins finds no config dir and the
  // hard-link cases would pass vacuously.
  const pluginVault = (): string => {
    const root = vault();
    writeFileSync(join(root, ".obsidian", "app.json"), "{}");
    return root;
  };

  it("skips a manifest.json that is a hard link", () => {
    const root = pluginVault();
    plantHardLink(root, manifest("leaked"), ".obsidian/plugins/leaked/manifest.json");
    const found = discoverPlugins(root);
    expect(found.configDir).not.toBeNull();
    expect(JSON.stringify(found)).not.toContain("SECRET");
    expect(found.installed).toEqual([]);
  });
  it("does not read an enabled-set from a community-plugins.json that is a hard link", () => {
    const root = pluginVault();
    mkdirSync(join(root, ".obsidian", "plugins", "p1"), { recursive: true });
    writeFileSync(join(root, ".obsidian", "plugins", "p1", "manifest.json"), manifest("p1"));
    plantHardLink(root, '["p1"]', ".obsidian/community-plugins.json");
    expect(discoverPlugins(root).installed.map((p) => [p.id, p.enabled])).toEqual([["p1", false]]);
  });
  it("still reads a normal manifest and enabled set", () => {
    const root = pluginVault();
    mkdirSync(join(root, ".obsidian", "plugins", "p1"), { recursive: true });
    writeFileSync(join(root, ".obsidian", "plugins", "p1", "manifest.json"), manifest("p1"));
    writeFileSync(join(root, ".obsidian", "community-plugins.json"), '["p1"]');
    expect(discoverPlugins(root).installed.map((p) => [p.id, p.enabled])).toEqual([["p1", true]]);
  });
});

describe("workspace/sessions readTrace (session trace JSONL)", () => {
  it("refuses a trace file that is a hard link", () => {
    const root = vault();
    const abs = plantHardLink(root, '{"secret":"SECRET-TRACE"}\n', "memory/t.jsonl");
    expect(() => readTrace(abs)).toThrow(/hard-link|inode|safe open refused/i);
  });
  it("still replays a normal trace and treats a missing one as empty", () => {
    const root = vault();
    const abs = join(root, "memory", "t.jsonl");
    writeFileSync(abs, '{"a":1}\n\n{"a":2}\n');
    expect(readTrace(abs)).toEqual([{ a: 1 }, { a: 2 }]);
    expect(readTrace(join(root, "memory", "none.jsonl"))).toEqual([]);
  });
});

describe("provenance/digest digestUnder", () => {
  it("is unhashable for a path that is a hard link", async () => {
    const root = vault();
    plantHardLink(root, "SECRET", "memory/linked.md");
    expect(await digestUnder(root, "memory/linked.md")).toBe(DIGEST_UNHASHABLE);
  });
  it("still hashes a normal file", async () => {
    const root = vault();
    writeFileSync(join(root, "memory", "plain.md"), "hello");
    const d = await digestUnder(root, "memory/plain.md");
    expect(d).toMatch(/^[0-9a-f]{64}$/);
  });
});
