// THE-1039 (GH #930) — `obsidian-tc compact` end to end.
//
// SUBPROCESS, not an import — same rationale as session-rerun-sandbox-e2e.test.ts's own header:
// `run_compact` calls `process.exit` on a busy/integrity failure, and `main()` does too on a usage
// error, so importing either directly risks corrupting this test run's own exit code. Spawning the
// real CLI is also the only way to observe the actual operator-facing surface.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import { ensureNotesFts } from "../src/search/fts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): Run {
  const r = spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** A real cache.db with notes_fts written across many separate transactions — same shape as
 *  maintenance.test.ts's own THE-1039 fixture — so FTS5's own 'optimize' (and the VACUUM after
 *  it) has real, measurable segment/freelist bloat to reclaim. Closes the handle before returning
 *  so the CLI subprocess is the only writer. */
async function seedInflatedCacheDb(cacheDir: string): Promise<void> {
  const db = await openDatabase(join(cacheDir, "cache.db"));
  provisionCacheDb(db, { version: "test" });
  expect(ensureNotesFts(db)).toBe(true);
  const ins = db.prepare(
    "INSERT INTO notes_fts (vault_id, path, title, content) VALUES ('v1', ?, ?, ?)",
  );
  for (let i = 0; i < 300; i++) {
    ins.run(
      `note-${i}.md`,
      `Note number ${i}`,
      `content for note number ${i} — repeated filler text so the index has real bytes to merge and vacuum away. `.repeat(
        20,
      ),
    );
  }
  db.close?.();
}

function setupConfig(): { cacheDir: string; configPath: string } {
  const vaultDir = mkdtempSync(join(tmpdir(), "obtc-compact-vault-"));
  const cacheDir = mkdtempSync(join(tmpdir(), "obtc-compact-cache-"));
  const confDir = mkdtempSync(join(tmpdir(), "obtc-compact-conf-"));
  dirs.push(vaultDir, cacheDir, confDir);
  writeFileSync(join(vaultDir, "a.md"), "hello");
  const configPath = join(confDir, "config.json");
  writeFileSync(configPath, JSON.stringify({ cacheDir, vaults: [{ id: "main", path: vaultDir }] }));
  return { cacheDir, configPath };
}

describe("THE-1039 (GH #930) — obsidian-tc compact (end to end)", () => {
  it("shrinks cache.db in place: FTS5 optimize + VACUUM reclaim real bytes", async () => {
    const { cacheDir, configPath } = setupConfig();
    await seedInflatedCacheDb(cacheDir);
    const dbPath = join(cacheDir, "cache.db");
    const beforeBytes = statSync(dbPath).size;

    const r = runCli(["compact", "--config", configPath, "--json", join(cacheDir, "report.json")]);
    expect(r.code, `compact exited ${r.code}, stderr: ${r.stderr}`).toBe(0);

    const afterBytes = statSync(dbPath).size;
    expect(afterBytes).toBeLessThan(beforeBytes);
    expect(r.stdout).toContain("cache.db");

    const report = JSON.parse(readFileSync(join(cacheDir, "report.json"), "utf8")) as Array<{
      db: string;
      ftsOptimized: string[];
      integrityOk: boolean;
    }>;
    const cacheReport = report.find((x) => x.db === "cache.db");
    expect(cacheReport?.ftsOptimized).toEqual(["notes_fts"]);
    expect(cacheReport?.integrityOk).toBe(true);
  }, 30_000);

  it("--into copies via VACUUM INTO, verifies the copy, and leaves the live file byte-for-byte untouched", async () => {
    const { cacheDir, configPath } = setupConfig();
    await seedInflatedCacheDb(cacheDir);
    const dbPath = join(cacheDir, "cache.db");
    const destDir = mkdtempSync(join(tmpdir(), "obtc-compact-into-"));
    dirs.push(destDir);
    const hashBefore = sha256(dbPath);

    const r = runCli(["compact", "--config", configPath, "--into", destDir]);
    expect(r.code, `compact --into exited ${r.code}, stderr: ${r.stderr}`).toBe(0);

    // THE property this test exists to prove: the LIVE file is untouched.
    expect(sha256(dbPath)).toBe(hashBefore);

    const copyPath = join(destDir, "cache.db");
    expect(existsSync(copyPath)).toBe(true);
    expect(statSync(copyPath).size).toBeLessThan(statSync(dbPath).size);
    // The exact `mv` an operator would run to install the verified copy.
    expect(r.stdout).toMatch(/mv '.*cache\.db' '.*cache\.db'/);
  }, 30_000);

  it("--dry-run reports sizes and changes nothing", async () => {
    const { cacheDir, configPath } = setupConfig();
    await seedInflatedCacheDb(cacheDir);
    const dbPath = join(cacheDir, "cache.db");
    const hashBefore = sha256(dbPath);

    const r = runCli(["compact", "--config", configPath, "--dry-run"]);
    expect(r.code, `compact --dry-run exited ${r.code}, stderr: ${r.stderr}`).toBe(0);
    expect(sha256(dbPath)).toBe(hashBefore);
    expect(r.stdout).toContain("notes_fts_data");
  }, 30_000);
});
