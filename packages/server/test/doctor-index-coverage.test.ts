// index.coverage (THE-1073) — are the notes on disk the same set as the notes actually indexed?
//
// Mirrors doctor-note-summary-scale.test.ts's shape for the check itself (not-probed -> ok,
// probed-and-clean -> ok, probed-and-short -> warning, never fail), plus an integration test of the
// real probe (probeIndexCoverage) against a temp vault + a real provisioned cache.db — the doctor
// probe test the ticket asks for: 3 notes on disk, 2 rows in `notes`, so 1 is missing.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import {
  type IndexCoverageState,
  indexCoverageCheck,
  probeIndexCoverage,
} from "../src/doctor/index-coverage";
import { rmTemp } from "./tmp";

const ctx = { serverVersion: "test" };
const run = (states?: IndexCoverageState[]) =>
  indexCoverageCheck(states ? { probe: () => states } : {}).run(ctx);

describe("index.coverage check (THE-1073)", () => {
  it("is ok and says 'not probed' when no probe was attached", async () => {
    const r = await run();
    expect(r.status).toBe("ok");
    expect(r.details?.coverage).toBe("not probed");
  });

  it("is ok on an empty probe result — no vault to inspect", async () => {
    const r = await run([]);
    expect(r.status).toBe("ok");
    expect(r.details?.coverage).toBe("no vault");
  });

  it("is ok when every vault's on-disk notes are fully indexed", async () => {
    const r = await run([
      { vaultId: "main", notesOnDisk: 10, notesIndexed: 10, missing: 0, samplePaths: [] },
    ]);
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("every note on disk is indexed");
  });

  it("WARNS when a vault has notes on disk but not indexed, and names the sample path", async () => {
    const r = await run([
      {
        vaultId: "main",
        notesOnDisk: 3,
        notesIndexed: 2,
        missing: 1,
        samplePaths: ["bad-frontmatter.md"],
      },
    ]);
    expect(r.status).toBe("warning");
    expect(r.issues?.join(" ")).toContain("main");
    expect(r.issues?.join(" ")).toContain("bad-frontmatter.md");
    expect(r.remediation).toBeTruthy();
  });

  it("never returns fail — a coverage gap breaks no request outright", async () => {
    const r = await run([
      { vaultId: "main", notesOnDisk: 100, notesIndexed: 1, missing: 99, samplePaths: ["a.md"] },
    ]);
    expect(r.status).toBe("warning");
    expect(r.status).not.toBe("fail");
  });
});

describe("probeIndexCoverage (THE-1073)", () => {
  it("3 notes on disk, 2 rows in `notes` -> missing 1, sample names the path", async () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "obtc-coverage-vault-"));
    const cacheDir = mkdtempSync(join(tmpdir(), "obtc-coverage-cache-"));
    try {
      writeFileSync(join(vaultRoot, "alpha.md"), "# Alpha\n");
      writeFileSync(join(vaultRoot, "beta.md"), "# Beta\n");
      writeFileSync(join(vaultRoot, "gamma-unindexed.md"), "# Gamma\n");
      mkdirSync(join(vaultRoot, "sub"), { recursive: true });

      const db = await openDatabase(join(cacheDir, "cache.db"), 5_000);
      provisionCacheDb(db);
      const insert = db.prepare(
        "INSERT INTO notes (vault_id, path, title, tags, frontmatter, content_hash, mtime, size, indexed_at) VALUES (?,?,?,'[]',NULL,?,1,1,1)",
      );
      insert.run("main", "alpha.md", "Alpha", "hash-alpha");
      insert.run("main", "beta.md", "Beta", "hash-beta");
      db.close?.();

      const states = await probeIndexCoverage(
        cacheDir,
        [{ id: "main", root: vaultRoot, isReadable: () => true }],
        5_000,
      );
      expect(states).toHaveLength(1);
      expect(states[0]?.notesOnDisk).toBe(3);
      expect(states[0]?.notesIndexed).toBe(2);
      expect(states[0]?.missing).toBe(1);
      expect(states[0]?.samplePaths).toEqual(["gamma-unindexed.md"]);

      // Folded through the check itself: WARNs and names the path.
      const result = indexCoverageCheck({ probe: () => states }).run(ctx);
      expect((await result).status).toBe("warning");
    } finally {
      rmTemp(vaultRoot);
      rmTemp(cacheDir);
    }
  });

  it("probe is absent without --probe (doctor CLI wiring only attaches it under cmd.probe)", async () => {
    // No probe attached: the check itself falls back to "not probed" — the field's whole contract
    // (see cli/commands/doctor.ts's `cmd.probe ? await probeIndexCoverage(...) : undefined`).
    const r = await indexCoverageCheck({}).run(ctx);
    expect(r.status).toBe("ok");
    expect(r.details?.coverage).toBe("not probed");
  });

  it("returns [] when cache.db does not exist yet — never throws on a fresh install", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "obtc-coverage-nodb-"));
    try {
      const states = await probeIndexCoverage(cacheDir, [], 5_000);
      expect(states).toEqual([]);
    } finally {
      rmTemp(cacheDir);
    }
  });
});
