import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/open";
import { applyImport } from "../src/memory-import/apply";
import { buildParsedSource } from "../src/memory-import/plan";
import { makeMemoryImportHarness } from "./memory-import-helpers";

const FIXTURE_ROOT = fileURLToPath(new URL("fixtures/memory-import/basic-memory", import.meta.url));
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe("PR #978 adversarial importer verification", () => {
  it("--resume refuses an owned zero-observation projection whose body gained human content", async () => {
    const h = makeMemoryImportHarness();
    try {
      const created = await h.dispatch("create_entity", {
        vault: "test",
        type: "note",
        name: "Coffee Brewing Methods",
        materialize: true,
      });
      expect(created.ok).toBe(true);
      const path = "memory/note/Coffee Brewing Methods.md";
      const original = h.read(path);
      const edited = `${original}\nPRIVATE HUMAN CONTENT THAT MUST SURVIVE\n`;
      writeFileSync(join(h.vaultRoot, path), edited);

      const report = await applyImport(buildParsedSource(FIXTURE_ROOT, "basic-memory"), {
        vault: "test",
        adapter: "basic-memory",
        dispatch: h.dispatch,
        applied: true,
        resume: true,
        now: () => "2026-01-02T00:00:00.000Z",
      });

      const coffee = report.entities.find((e) => e.name === "Coffee Brewing Methods");
      expect.soft(coffee?.action).toBe("collision");
      expect.soft(h.read(path)).toBe(edited);
    } finally {
      h.cleanup();
    }
  });

  it("dry-run reports a clear migration requirement and does not migrate an old cache.db", async () => {
    const root = scratch("obtc-zz-memory-import-");
    const vaultDir = join(root, "vault");
    const sourceDir = join(root, "source");
    const cacheDir = join(root, "cache");
    mkdirSync(vaultDir, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(sourceDir, "note.md"),
      "---\ntitle: Old DB Probe\ntype: note\n---\n## Observations\n- [fact] hello\n",
    );
    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ vaults: [{ id: "main", path: vaultDir }], cacheDir }),
    );

    const dbPath = join(cacheDir, "cache.db");
    const oldDb = await openDatabase(dbPath);
    oldDb.exec(
      "CREATE TABLE sentinel (value TEXT NOT NULL); INSERT INTO sentinel VALUES ('untouched')",
    );
    oldDb.close?.();

    const run = spawnSync(
      "bun",
      [
        CLI,
        "memory",
        "import",
        "--from",
        "basic-memory",
        sourceDir,
        "--config",
        configPath,
        "--vault",
        "main",
      ],
      { encoding: "utf8", timeout: 20_000, env: { ...process.env, NO_COLOR: "1" } },
    );

    expect.soft(run.status).not.toBe(0);
    expect
      .soft(`${run.stdout}\n${run.stderr}`)
      .toMatch(/cache\.db.*(?:migration|schema).*required/i);

    const verifyDb = await openDatabase(dbPath, undefined, { readonly: true });
    expect(verifyDb.prepare("SELECT value FROM sentinel").get()).toEqual({ value: "untouched" });
    expect(
      verifyDb
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'memory_entities'",
        )
        .get(),
    ).toEqual({ n: 0 });
    verifyDb.close?.();
  });
});
