import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getOrCreateWikiSealKey,
  inspectGenerated,
  readWikiSealKey,
  seal,
} from "../src/tools/m7/knowledge/wiki-generated-seal";
import { makeTempDir, rmTemp } from "./tmp";
import { WIKI_TEST_SEAL_KEY } from "./wiki-test-helpers";

const KEY = WIKI_TEST_SEAL_KEY;
const IDENTITY = { vaultId: "alpha", path: "wiki/log.md" };
const template = (lastSeq = 7): string =>
  `---\ngenerated_by: obsidian-tc\ngenerated_page: log\ngenerated_vault: "alpha"\ngenerated_path: "wiki/log.md"\nlast_seq: ${lastSeq}\ngenerated_hash: \n---\n# Wiki log\n`;
const oldSeal = (raw: string): string => {
  const blank = raw.replace(/^generated_hash: ?.*$/m, "generated_hash: ");
  const digest = createHash("sha256").update(blank, "utf8").digest("hex");
  return blank.replace(/^generated_hash: ?.*$/m, `generated_hash: ${digest}`);
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmTemp(dir);
});

describe("generated wiki page HMAC seal", () => {
  it("rejects a forge made with the old unkeyed SHA-256 scheme", () => {
    const forged = oldSeal(template(999_999));
    expect(inspectGenerated(forged, KEY, IDENTITY)).not.toBe("ours");
  });

  it("detects an edited last_seq even when the attacker recomputes the old SHA seal", () => {
    const keyed = seal(template(7), KEY, IDENTITY);
    const edited = keyed.replace("last_seq: 7", "last_seq: 999999");
    const forged = oldSeal(edited);
    expect(inspectGenerated(forged, KEY, IDENTITY)).toBe("legacy");
  });

  it("binds a seal to both its vault and its generated file path", () => {
    const keyed = seal(template(7), KEY, IDENTITY);
    expect(inspectGenerated(keyed, KEY, IDENTITY)).toBe("ours");
    expect(inspectGenerated(keyed, KEY, { vaultId: "beta", path: IDENTITY.path })).toBe("foreign");
    expect(inspectGenerated(keyed, KEY, { vaultId: IDENTITY.vaultId, path: "wiki/index.md" })).toBe(
      "foreign",
    );
  });

  it("creates one stable per-server key in a private file", () => {
    const cacheDir = makeTempDir("obtc-wiki-seal-");
    dirs.push(cacheDir);
    const first = getOrCreateWikiSealKey(cacheDir);
    const second = getOrCreateWikiSealKey(cacheDir);
    expect(first).toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(32);
    if (process.platform !== "win32") {
      expect(statSync(`${cacheDir}/server-secrets`).mode & 0o777).toBe(0o700);
      expect(statSync(`${cacheDir}/server-secrets/wiki-generated.key`).mode & 0o777).toBe(0o600);
    }
    chmodSync(`${cacheDir}/server-secrets/wiki-generated.key`, 0o644);
    if (process.platform !== "win32")
      expect(() => getOrCreateWikiSealKey(cacheDir)).toThrow(/0600/);
  });

  it("read-only key lookup leaves a missing cache directory untouched", () => {
    const cacheDir = makeTempDir("obtc-wiki-seal-read-");
    dirs.push(cacheDir);
    expect(readWikiSealKey(cacheDir)).toBeUndefined();
    expect(existsSync(`${cacheDir}/server-secrets`)).toBe(false);
  });

  for (const [name, contents] of [
    ["empty", ""],
    ["partial", "truncated"],
  ] as const)
    it(`atomically repairs a ${name} key file and logs the corruption`, () => {
      const cacheDir = makeTempDir(`obtc-wiki-seal-${name}-`);
      dirs.push(cacheDir);
      mkdirSync(`${cacheDir}/server-secrets`, { recursive: true, mode: 0o700 });
      writeFileSync(`${cacheDir}/server-secrets/wiki-generated.key`, contents, { mode: 0o600 });
      const logged = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const key = getOrCreateWikiSealKey(cacheDir);
      expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(getOrCreateWikiSealKey(cacheDir)).toBe(key);
      expect(logged.mock.calls.flat().join(" ")).toMatch(/empty|corrupt/i);
    });
});
