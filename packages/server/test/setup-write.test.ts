// `obsidian-tc setup`'s writer (PR A of GH #995's two-part follow-up): validates, writes
// atomically, refuses to clobber an existing config without --force, and backs one up first when
// --force is given.
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SetupDecision } from "../src/cli/setup/decide";
import { buildSetupConfig, writeSetupConfig } from "../src/cli/setup/write";
import { rmTemp } from "./tmp";

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
      /* best-effort */
    }
  }
});

function decision(overrides: Partial<SetupDecision> = {}): SetupDecision {
  return {
    vaults: [{ id: "main", path: "/vault" }],
    cacheDir: join(tmpDir("otc-setup-cache-"), ".obsidian-tc"),
    embeddings: {
      provider: "local",
      model: "nomic-embed-text-v1.5",
      dimensions: 768,
      reason: "test",
    },
    hostedSuggestions: [],
    ...overrides,
  };
}

describe("buildSetupConfig", () => {
  it("writes every decided key explicitly, and no `threads`", () => {
    const raw = buildSetupConfig(decision());
    expect(raw.vaults).toEqual([{ id: "main", path: "/vault" }]);
    expect(raw.cacheDir).toEqual(expect.any(String));
    const embeddings = raw.embeddings as Record<string, unknown>;
    expect(embeddings).toEqual({
      provider: "local",
      model: "nomic-embed-text-v1.5",
      dimensions: 768,
    });
    expect(embeddings.threads).toBeUndefined();
  });

  it("carries embeddings.revision through when the decision set one", () => {
    const raw = buildSetupConfig(
      decision({
        embeddings: {
          provider: "ollama",
          model: "nomic-embed-text",
          dimensions: 768,
          reason: "test",
          revision: "sha123",
        },
      }),
    );
    expect((raw.embeddings as Record<string, unknown>).revision).toBe("sha123");
  });

  // Fix round, finding 2: an existing raw config's keys setup does not own (here `auth`) must
  // survive unchanged, and a vault/cacheDir/embeddings the existing file already named explicitly
  // must not be overwritten by a fresh decision.
  describe("merging into an existing raw config", () => {
    it("preserves keys setup does not own", () => {
      const raw = buildSetupConfig(decision(), {
        auth: { jwtSecret: "keep-me" },
        vaults: [],
      });
      expect(raw.auth).toEqual({ jwtSecret: "keep-me" });
    });

    it("unions vaults by id — existing entries win, new detected ones are appended", () => {
      const raw = buildSetupConfig(
        decision({
          vaults: [
            { id: "main", path: "/detected/path" },
            { id: "second", path: "/s" },
          ],
        }),
        { vaults: [{ id: "main", path: "/existing/path" }] },
      );
      expect(raw.vaults).toEqual([
        { id: "main", path: "/existing/path" },
        { id: "second", path: "/s" },
      ]);
    });

    it("does not overwrite an explicit existing cacheDir", () => {
      const raw = buildSetupConfig(decision(), { cacheDir: "/already/set" });
      expect(raw.cacheDir).toBe("/already/set");
    });

    it("fills cacheDir when the existing raw config never named it", () => {
      const d = decision();
      const raw = buildSetupConfig(d, { vaults: [] });
      expect(raw.cacheDir).toBe(d.cacheDir);
    });

    it("does not overwrite an existing explicit embeddings.provider", () => {
      const raw = buildSetupConfig(decision(), {
        embeddings: { provider: "openai", model: "text-embedding-3-large", dimensions: 3072 },
      });
      expect(raw.embeddings).toEqual({
        provider: "openai",
        model: "text-embedding-3-large",
        dimensions: 3072,
      });
    });

    // Fix round 2 (Codex review 1001-verify-r2), LOW finding 10: a pre-1.31.4 config that set
    // `embeddings.model`/`.dimensions` WITHOUT ever setting `provider` (sticky-provider.ts's own
    // header names this exact shape as historically valid) must not have those fields silently
    // replaced by a fresh decision — the gate for "the operator already made an explicit choice
    // here" must not be `provider` alone.
    it("does not overwrite existing embeddings.model/.dimensions when only provider is absent", () => {
      const raw = buildSetupConfig(decision(), {
        embeddings: { model: "nomic-embed-text", dimensions: 768 },
      });
      expect(raw.embeddings).toEqual({ model: "nomic-embed-text", dimensions: 768 });
    });

    it("fills embeddings when the existing raw config never named provider explicitly", () => {
      const raw = buildSetupConfig(decision(), { embeddings: { threads: 4 } });
      expect(raw.embeddings).toEqual({
        threads: 4,
        provider: "local",
        model: "nomic-embed-text-v1.5",
        dimensions: 768,
      });
    });
  });
});

describe("writeSetupConfig", () => {
  it("validates through ServerConfigSchema and writes a loadable config", () => {
    const dir = tmpDir("otc-setup-write-");
    const target = join(dir, "config.json");
    const result = writeSetupConfig(target, decision());
    expect(existsSync(target)).toBe(true);
    expect(result.config.vaults[0]?.id).toBe("main");
    const onDisk = JSON.parse(readFileSync(target, "utf8"));
    expect(onDisk.embeddings.provider).toBe("local");
  });

  it("writes atomically: no leftover .tmp-* file survives a successful write", () => {
    const dir = tmpDir("otc-setup-write-atomic-");
    const target = join(dir, "config.json");
    writeSetupConfig(target, decision());
    const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  it("refuses to overwrite an existing config without --force", () => {
    const dir = tmpDir("otc-setup-write-noforce-");
    const target = join(dir, "config.json");
    writeFileSync(target, JSON.stringify({ existing: true }));
    expect(() => writeSetupConfig(target, decision())).toThrow(/--force/);
    // Refused BEFORE any mutation — the original content is untouched.
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ existing: true });
  });

  it("--force backs up the existing file first, with a timestamped name", () => {
    const dir = tmpDir("otc-setup-write-force-");
    const target = join(dir, "config.json");
    writeFileSync(target, JSON.stringify({ existing: true }));
    const result = writeSetupConfig(target, decision(), { force: true });
    expect(result.backupPath).toBeDefined();
    expect(result.backupPath).toMatch(/\.bak-/);
    expect(existsSync(result.backupPath as string)).toBe(true);
    expect(JSON.parse(readFileSync(result.backupPath as string, "utf8"))).toEqual({
      existing: true,
    });
    // The real path now holds the NEW config, not the backed-up one.
    expect(JSON.parse(readFileSync(target, "utf8")).existing).toBeUndefined();
  });

  it("refuses a .yaml/.yml target — the loader has no YAML support", () => {
    const dir = tmpDir("otc-setup-write-yaml-");
    const target = join(dir, "config.yaml");
    expect(() => writeSetupConfig(target, decision())).toThrow(/JSON only/);
    expect(existsSync(target)).toBe(false);
  });

  it("an invalid decision (schema rejects) writes nothing at all", () => {
    const dir = tmpDir("otc-setup-write-invalid-");
    const target = join(dir, "config.json");
    const bad = decision({ vaults: [] }); // ServerConfigSchema requires at least one vault
    expect(() => writeSetupConfig(target, bad)).toThrow();
    expect(existsSync(target)).toBe(false);
  });

  // Finding 1/5: decideSetup's refusal (embeddings undefined) must never reach a write.
  it("refuses to write when the decision has no embeddings (a refusal)", () => {
    const dir = tmpDir("otc-setup-write-refusal-");
    const target = join(dir, "config.json");
    const refused = decision();
    refused.embeddings = undefined; // simulating decideSetup's refusal shape
    expect(() => writeSetupConfig(target, refused)).toThrow(/no embeddings decision/);
    expect(existsSync(target)).toBe(false);
  });

  // Finding 8 (MEDIUM): permissions. POSIX-only (Windows CI, fix round 2): Node's fs on win32 does
  // not round-trip POSIX mode bits — `openSync(path, "wx", 0o600)` reads back as 0o666, and a mode
  // set via `writeFileSync(..., { mode: 0o400 })` makes the FILE read-only (toggling `--force`'s
  // `renameSync` into EPERM, covered separately in setup-write-platform.test.ts) rather than
  // producing a POSIX-comparable mode. Reproduced directly in CI (windows-latest): "expected 438 to
  // be 384" on the exact assertions below. The PRODUCTION mode-preservation logic itself is still
  // exercised — and still matters — on every platform CI covers with a real POSIX mode (Linux,
  // macOS); this block just stops asserting a POSIX-only invariant on a platform that has no POSIX
  // modes.
  describe.skipIf(process.platform === "win32")("file mode", () => {
    it("creates a new config at mode 0o600", () => {
      const dir = tmpDir("otc-setup-write-mode-new-");
      const target = join(dir, "config.json");
      writeSetupConfig(target, decision());
      expect(statSync(target).mode & 0o777).toBe(0o600);
    });

    it("--force preserves a STRICTER existing mode than 0o600", () => {
      const dir = tmpDir("otc-setup-write-mode-force-");
      const target = join(dir, "config.json");
      writeFileSync(target, JSON.stringify({ existing: true }), { mode: 0o400 });
      writeSetupConfig(target, decision(), { force: true });
      expect(statSync(target).mode & 0o777).toBe(0o400);
    });

    it("--force widens a LOOSER existing mode down to 0o600", () => {
      const dir = tmpDir("otc-setup-write-mode-widen-");
      const target = join(dir, "config.json");
      writeFileSync(target, JSON.stringify({ existing: true }), { mode: 0o666 });
      writeSetupConfig(target, decision(), { force: true });
      expect(statSync(target).mode & 0o777).toBe(0o600);
    });

    // Fix round 2 (Codex review 1001-verify-r2), LOW finding 9: "stricter than 0600" was a raw
    // numeric `<` comparison, so 0o444/0o477 (WORLD-READABLE, but numerically smaller than 0o600)
    // were wrongly treated as "stricter" and preserved.
    it("--force does NOT preserve a world-readable mode that is merely numerically smaller than 0o600", () => {
      const dir = tmpDir("otc-setup-write-mode-world-readable-");
      const target = join(dir, "config.json");
      writeFileSync(target, JSON.stringify({ existing: true }), { mode: 0o444 });
      writeSetupConfig(target, decision(), { force: true });
      expect(statSync(target).mode & 0o777).toBe(0o600);
    });
  });

  // Finding 6 (MEDIUM): baseline — an existing target refuses a no-force write and is left
  // untouched. See setup-write-toctou.test.ts for the proof that the REAL guard is the exclusive
  // `linkSync`, not this module's own early `existsSync` check (which a race can outrun).
  it("no-force write refuses an existing target and leaves it untouched", () => {
    const dir = tmpDir("otc-setup-write-toctou-baseline-");
    const target = join(dir, "config.json");
    writeFileSync(target, JSON.stringify({ raced: true }));
    expect(() => writeSetupConfig(target, decision())).toThrow(/already exists/);
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ raced: true });
  });

  // Low: backup collisions — exclusive create with a counter suffix.
  it("two --force overwrites in the same run never clobber each other's backup", () => {
    const dir = tmpDir("otc-setup-write-backup-collision-");
    const target = join(dir, "config.json");
    writeFileSync(target, JSON.stringify({ n: 1 }));
    const first = writeSetupConfig(target, decision(), { force: true });
    writeFileSync(target, JSON.stringify({ n: 2 }));
    const second = writeSetupConfig(target, decision(), { force: true });
    expect(first.backupPath).not.toBe(second.backupPath);
    expect(existsSync(first.backupPath as string)).toBe(true);
    expect(existsSync(second.backupPath as string)).toBe(true);
    expect(JSON.parse(readFileSync(first.backupPath as string, "utf8"))).toEqual({ n: 1 });
    expect(JSON.parse(readFileSync(second.backupPath as string, "utf8"))).toEqual({ n: 2 });
  });

  // Low: symlink target — resolved and the write lands on the referent, backing it up, never
  // replacing the link pathname with a regular file.
  it("a symlinked --force target resolves to the referent: the link itself is untouched", () => {
    const dir = tmpDir("otc-setup-write-symlink-");
    const realTarget = join(dir, "real-config.json");
    const link = join(dir, "config.json");
    writeFileSync(realTarget, JSON.stringify({ existing: true }));
    symlinkSync(realTarget, link);
    const result = writeSetupConfig(link, decision(), { force: true });
    expect(result.path).toBe(realTarget);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(realTarget, "utf8")).vaults).toBeDefined();
    expect(JSON.parse(readFileSync(result.backupPath as string, "utf8"))).toEqual({
      existing: true,
    });
  });

  it("a symlink pointing at a nonexistent file is refused, not silently replaced", () => {
    const dir = tmpDir("otc-setup-write-symlink-broken-");
    const link = join(dir, "config.json");
    symlinkSync(join(dir, "does-not-exist.json"), link);
    expect(() => writeSetupConfig(link, decision(), { force: true })).toThrow(/symlink/);
  });
});
