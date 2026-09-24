// index.coverage (THE-1073) — are the notes on disk the same set as the notes actually indexed?
//
// Mirrors doctor-note-summary-scale.test.ts's shape for the check itself (not-probed -> ok,
// probed-and-clean -> ok, probed-and-short -> warning, never fail), plus integration tests of the
// real probe (probeIndexCoverage) measured against the real WRITER (indexVault), not hand-inserted
// `notes` rows — fix round 1 (MEDIUM, Opus): a hand-inserted-rows fixture cannot catch the probe
// disagreeing with indexVault about which walked files get a `notes` row at all (a zero-byte note
// gets none — see search/fts.ts's notesRowExpectedForSize, shared by both sides).
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
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
import { fakeEmbeddingProvider } from "../src/embeddings";
import { indexVault } from "../src/search/indexer";
import { buildRepresentationManifest } from "../src/search/representation";
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

  // Fix round 1 (MEDIUM, Codex): a per-vault probe FAILURE (symlinked root, locked cache.db) must
  // render as a warning naming the exception — never silently collapsed into the same "ok, no
  // vault to inspect" a genuinely fresh install gets.
  it("WARNS naming the exception when a vault's own probe failed, distinct from a missing-notes warning", async () => {
    const r = await run([
      {
        vaultId: "main",
        notesOnDisk: 0,
        notesIndexed: 0,
        missing: 0,
        samplePaths: [],
        error: "vault root contains a symlink in its final path component",
      },
    ]);
    expect(r.status).toBe("warning");
    expect(r.issues?.join(" ")).toContain("main");
    expect(r.issues?.join(" ")).toContain("symlink in its final path component");
    expect(r.details?.counts).toEqual(["main=ERROR"]);
  });

  it("reports BOTH a probe failure and a genuine missing-notes gap when different vaults hit each", async () => {
    const r = await run([
      {
        vaultId: "broken",
        notesOnDisk: 0,
        notesIndexed: 0,
        missing: 0,
        samplePaths: [],
        error: "boom",
      },
      { vaultId: "short", notesOnDisk: 3, notesIndexed: 2, missing: 1, samplePaths: ["x.md"] },
    ]);
    expect(r.status).toBe("warning");
    expect(r.issues?.join(" ")).toContain("broken");
    expect(r.issues?.join(" ")).toContain("short");
  });
});

describe("probeIndexCoverage (THE-1073)", () => {
  it("a real indexVault pass with a frontmatter-invalid note -> missing 1, sample names the path", async () => {
    // The doctor probe test the ticket asks for, measured against the real writer: index THREE
    // real files (one with invalid YAML frontmatter — the actual THE-1073 scenario, not a
    // hand-inserted row), then probe. gamma.md is unindexed because indexVault itself skipped it.
    const vaultRoot = mkdtempSync(join(tmpdir(), "obtc-coverage-vault-"));
    const cacheDir = mkdtempSync(join(tmpdir(), "obtc-coverage-cache-"));
    try {
      writeFileSync(join(vaultRoot, "alpha.md"), "# Alpha\n\nfine.");
      writeFileSync(join(vaultRoot, "beta.md"), "# Beta\n\nalso fine.");
      writeFileSync(join(vaultRoot, "gamma.md"), "---\nbad: [1, 2\n---\n# Gamma\n\nbroken YAML.");

      const db = await openDatabase(join(cacheDir, "cache.db"), 5_000);
      provisionCacheDb(db);
      const provider = fakeEmbeddingProvider({ dimensions: 8 });
      const stats = await indexVault({
        db,
        provider,
        vaultId: "main",
        root: vaultRoot,
        isReadable: () => true,
        representation: buildRepresentationManifest(provider, {}),
      });
      expect(stats.notes_frontmatter_failed).toBe(1);
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
      expect(states[0]?.samplePaths).toEqual(["gamma.md"]);

      // Folded through the check itself: WARNs and names the path.
      const result = indexCoverageCheck({ probe: () => states }).run(ctx);
      expect((await result).status).toBe("warning");
    } finally {
      rmTemp(vaultRoot);
      rmTemp(cacheDir);
    }
  });

  // Fix round 1 (MEDIUM, Opus): index.coverage warned forever on a zero-byte note, because
  // indexVault never writes a `notes` row for `raw === ""` — the probe now shares indexVault's own
  // notesRowExpectedForSize predicate, so this vault reads clean (0 missing) despite an empty note, a
  // secret-only note (still gets a row; only its CHUNK is gated) and an egress-excluded note
  // (excluded from embedding, not from indexing) all sitting alongside a normal one. Reviewer
  // repro, adapted: a real indexVault pass with these four files must leave `missing` at 0.
  it("a real indexVault pass with an empty note, a secret-only note, and an egress-excluded note reads clean (0 missing)", async () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "obtc-coverage-parity-vault-"));
    const cacheDir = mkdtempSync(join(tmpdir(), "obtc-coverage-parity-cache-"));
    try {
      writeFileSync(join(vaultRoot, "a.md"), "# A\n\nhello world");
      writeFileSync(join(vaultRoot, "empty.md"), "");
      mkdirSync(join(vaultRoot, "private"), { recursive: true });
      writeFileSync(join(vaultRoot, "private/secret.md"), "# S\n\nexcluded from egress");
      writeFileSync(
        join(vaultRoot, "only-secret.md"),
        "AKIAIOSFODNN7EXAMPLE aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n",
      );
      // Fix round 2 (LOW): three more edge shapes the size-based predicate must still agree with
      // indexVault on — frontmatter-only (non-empty raw, empty BODY), a lone byte-order mark
      // (non-empty in bytes, "looks empty" visually), and a single newline (non-empty in bytes,
      // "looks empty" when trimmed). All three are non-zero BYTE LENGTH, so all three get a `notes`
      // row, same as indexVault.
      writeFileSync(join(vaultRoot, "fm-only.md"), "---\ntitle: X\n---\n");
      writeFileSync(join(vaultRoot, "bom.md"), "﻿");
      writeFileSync(join(vaultRoot, "ws.md"), "\n");

      const db = await openDatabase(join(cacheDir, "cache.db"), 5_000);
      provisionCacheDb(db);
      const provider = fakeEmbeddingProvider({ dimensions: 8 });
      await indexVault({
        db,
        provider,
        vaultId: "main",
        root: vaultRoot,
        isReadable: () => true,
        representation: buildRepresentationManifest(provider, {}),
        isEgressExcluded: (r: string) => r.startsWith("private/"),
      });
      db.close?.();

      const states = await probeIndexCoverage(
        cacheDir,
        [{ id: "main", root: vaultRoot, isReadable: () => true }],
        5_000,
      );
      expect(states).toHaveLength(1);
      expect(states[0]?.missing).toBe(0);
      expect(states[0]?.notesOnDisk).toBe(6); // empty.md excluded from BOTH sides, correctly
      expect(states[0]?.notesIndexed).toBe(6);
    } finally {
      rmTemp(vaultRoot);
      rmTemp(cacheDir);
    }
  });

  // Fix round 1 (MEDIUM, Codex): a symlinked vault root made walkVault refuse the vault
  // (assertRootNotPlantedSymlink), and the original probe swallowed that exception into the same
  // `[]` a fresh install with no cache.db yet gets — reading as a clean "ok, no vault to inspect"
  // instead of a warning. This must now surface as a per-vault `error`.
  it("a symlinked vault root reports a per-vault error, not a silent empty result", async () => {
    const realRoot = mkdtempSync(join(tmpdir(), "obtc-coverage-real-"));
    const linkParent = mkdtempSync(join(tmpdir(), "obtc-coverage-link-parent-"));
    const cacheDir = mkdtempSync(join(tmpdir(), "obtc-coverage-symlink-cache-"));
    const symlinkRoot = join(linkParent, "vault-link");
    try {
      writeFileSync(join(realRoot, "a.md"), "# A\n\nfine.");
      symlinkSync(realRoot, symlinkRoot, "dir");

      const db = await openDatabase(join(cacheDir, "cache.db"), 5_000);
      provisionCacheDb(db);
      db.close?.();

      const states = await probeIndexCoverage(
        cacheDir,
        [{ id: "main", root: symlinkRoot, isReadable: () => true }],
        5_000,
      );
      expect(states).toHaveLength(1);
      expect(states[0]?.error).toBeTruthy();
      expect(states[0]?.notesOnDisk).toBe(0);

      const result = await indexCoverageCheck({ probe: () => states }).run(ctx);
      expect(result.status).toBe("warning");
      expect(result.issues?.join(" ")).toContain("main");
    } finally {
      rmTemp(realRoot);
      rmTemp(linkParent);
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
