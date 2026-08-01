import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli/args";
import { installPlugin } from "../src/cli/plugin-install";
import { rmTemp } from "./tmp";

// THE-685: every temp dir this suite creates is tracked and removed. These calls previously had NO
// teardown at all — a leak on every OS, invisible on POSIX (where /tmp is reaped) and unbounded on
// Windows (where %TEMP% is not): 7,655 stale dirs measured on one box, this suite's prefixes among
// the largest contributors. Distinct from the teardown-that-FAILS class #627 fixes; that sweep is
// derived from suites that already had teardown, so by construction it could not reach this one.
const tmpDirs: string[] = [];
const tmpDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmTemp(d);
    } catch {
      // Best-effort by design: a leaked temp dir is cheaper than failing a suite in TEARDOWN with
      // every assertion passing — the exact shape #627 exists to remove. Same posture as
      // provider-module-threading.test.ts and scheduler.ts's cleanupReadOnlyDb.
    }
  }
});

function fakePluginSrc(): string {
  const dir = tmpDir("otc-plugin-src-");
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ id: "obsidian-tc", name: "Obsidian Turbocharged", version: "9.9.9" }),
  );
  writeFileSync(join(dir, "main.js"), "module.exports = {};");
  return dir;
}

describe("parseCliArgs — plugin install", () => {
  it("parses --vault and a positional path", () => {
    expect(parseCliArgs(["plugin", "install", "--vault", "/v"])).toEqual({
      kind: "plugin-install",
      vaultPath: "/v",
    });
    expect(parseCliArgs(["plugin", "install", "/v"])).toEqual({
      kind: "plugin-install",
      vaultPath: "/v",
    });
  });
  it("errors without a vault, and on an unknown plugin subcommand", () => {
    expect(parseCliArgs(["plugin", "install"]).kind).toBe("error");
    expect(parseCliArgs(["plugin", "bogus"]).kind).toBe("error");
  });
});

describe("installPlugin", () => {
  it("copies the plugin into <vault>/.obsidian/plugins/<id>/", () => {
    const src = fakePluginSrc();
    const vault = tmpDir("otc-vault-");
    const r = installPlugin(vault, src);
    expect(r.pluginId).toBe("obsidian-tc");
    expect(r.pluginVersion).toBe("9.9.9");
    const dest = join(vault, ".obsidian", "plugins", "obsidian-tc");
    expect(JSON.parse(readFileSync(join(dest, "manifest.json"), "utf8")).version).toBe("9.9.9");
    expect(readFileSync(join(dest, "main.js"), "utf8")).toBe("module.exports = {};");
  });
  it("creates .obsidian/plugins when absent and re-install overwrites (idempotent)", () => {
    const src = fakePluginSrc();
    const vault = tmpDir("otc-vault2-");
    installPlugin(vault, src);
    expect(() => installPlugin(vault, src)).not.toThrow();
  });
  it("rejects a non-existent vault", () => {
    const src = fakePluginSrc();
    expect(() => installPlugin(join(tmpdir(), "otc-missing-xyz"), src)).toThrow(/no such vault/);
  });
  it("errors when the bundled plugin is absent", () => {
    const vault = tmpDir("otc-vault3-");
    expect(() => installPlugin(vault, join(tmpdir(), "otc-no-plugin-src"))).toThrow(/not found/);
  });
});

function pluginSrcWith(manifestJson: string): string {
  const dir = tmpDir("otc-plugin-bad-");
  writeFileSync(join(dir, "manifest.json"), manifestJson);
  writeFileSync(join(dir, "main.js"), "module.exports = {};");
  return dir;
}

describe("installPlugin — manifest hardening", () => {
  it("rejects a manifest that is not valid JSON", () => {
    expect(() => installPlugin(tmpDir("otc-v-"), pluginSrcWith("{ not json "))).toThrow(
      /not valid JSON/,
    );
  });
  it("rejects a manifest missing name or version", () => {
    expect(() => installPlugin(tmpDir("otc-v2-"), pluginSrcWith('{"id":"obsidian-tc"}'))).toThrow(
      /name or version/,
    );
  });
});
