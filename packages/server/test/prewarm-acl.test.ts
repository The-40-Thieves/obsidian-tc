// THE-543 (Urgent security defect) — the prewarm cache bypassed caller ACL filtering. A bundle
// composed under one caller's ACL (a scheduled prefetch, or a live bootstrap) was cached under a
// vault-only key (prewarm-<vaultId>.json) and served to WHOEVER hit the bootstrap path next,
// regardless of their own ACL — caller A's cached results reached caller B verbatim.
//
// Three independent defences, all pinned here:
//   1. IDENTITY — the ACL fingerprint (THE-496, aclFingerprint) is part of the cache filename, so
//      entries for different effective ACLs cannot collide, plus a matching field re-validated on
//      read (belt-and-suspenders against a path-construction bug or a renamed file).
//   2. STALENESS — the vault generation (THE-496, readGeneration) is stored at write time and
//      re-validated on read; a mutation the signal note doesn't cover no longer serves stale
//      content until the TTL.
//   3. RE-FILTER ON READ — even a bundle whose key checks out is re-run through readableRel
//      before being trusted; a bundle that fails partially is a full miss, never a partial return.
//
// The lexical route (classRouter + a corpus-rare term) is used throughout so no embedding
// backend is needed — same trick as vault-context.test.ts.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { type AclConfigT, FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { ToolRegistry } from "../src/mcp/registry";
import { ensureChunkFts } from "../src/search/chunk_fts";
import { bumpGeneration, readGeneration } from "../src/search/generation";
import {
  callerAclFingerprint,
  type PrewarmEntry,
  prewarmPathFor,
  writePrewarm,
} from "../src/search/prefetch";
import { registerM7Tools } from "../src/tools/m7";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";

const NOW = 1_700_000_000_000;
const RARE_TERM = "glorbnaxis";
const SIGNAL_TEXT = `${RARE_TERM} notes`;
const SIGNAL_HASH = createHash("sha256").update(SIGNAL_TEXT).digest("hex");

/** Broad ACL: no readPaths whitelist, so every vault path is readable (the scheduled prefetch's
 *  "trusted" shape, and a stand-in for any caller whose ACL is wider than another's). */
const broadAclCfg: AclConfigT = {
  readOnly: false,
  defaultScopes: ["read:notes"],
  rules: [],
};
const broadAcl = new FolderAcl(broadAclCfg);

/** Narrow ACL: only public/** and memory/** (the signal note) are readable — secret/** is denied. */
const narrowAclCfg: AclConfigT = {
  readOnly: false,
  defaultScopes: ["read:notes"],
  rules: [],
  readPaths: ["public/**", "memory/**"],
};
const narrowAcl = new FolderAcl(narrowAclCfg);

const GRANTED = new Set(["read:notes"]);
const broadFp = callerAclFingerprint(broadAcl, GRANTED);
const narrowFp = callerAclFingerprint(narrowAcl, GRANTED);

function cacheDb(): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const ins = db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, 'main', ?, ?, '[]', ?, ?, ?, ?, ?)",
  );
  ins.run("pub1", "public/a.md", "0", `the ${RARE_TERM} pattern, public copy`, "hp", 40, NOW, NOW);
  ins.run("sec1", "secret/b.md", "0", `the ${RARE_TERM} pattern, SECRET copy`, "hs", 40, NOW, NOW);
  ensureChunkFts(db, { now: () => NOW, enrich: false });
  return db;
}

function un<T>(r: unknown): T {
  return (r as { data: T }).data;
}

interface ContextData {
  query_source: string;
  signal?: string;
  notes: Array<{ path: string; chunks: Array<{ chunk_id: string; content?: string }> }>;
  lessons: Array<{ path: string }>;
  prefetched?: boolean;
}

const root = mkdtempSync(join(tmpdir(), "obtc-pwacl-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function harness(db: Database, prewarmDir: string) {
  const registry = new ToolRegistry({});
  const vaultRegistry = new VaultRegistry([{ id: "main", name: "main", path: root }]);
  const embeddingProvider = {
    provider: "ollama",
    model: "stub",
    dimensions: 768,
    embed: async () => {
      throw new Error("embed must not be called on the lexical route");
    },
  };
  registerM7Tools(registry, {
    vaultRegistry,
    embeddingProvider: embeddingProvider as any,
    reranker: null,
    roles: null,
    classRouter: true,
    prewarmDir,
  });
  function ctxFor(acl: FolderAcl | undefined) {
    return {
      caller: "tester",
      authenticated: true,
      grantedScopes: GRANTED,
      vaultId: "main",
      db,
      ...(acl ? { acl } : {}),
    };
  }
  return { registry, ctxFor };
}

mkdirSync(join(root, "memory"), { recursive: true });
writeFileSync(join(root, "memory", "_next-session.md"), SIGNAL_TEXT);

describe("prewarm cache ACL leak (THE-543)", () => {
  it("leak test: a bundle composed under a BROAD ACL is never served to a NARROW-ACL caller", async () => {
    const db = cacheDb();
    const dir = mkdtempSync(join(tmpdir(), "obtc-pwacl-leak-"));
    try {
      const { registry, ctxFor } = harness(db, dir);

      // A live bootstrap compose under the broad ACL sees both notes and write-throughs the
      // prewarm cache (also exercises the live write-through writer, knowledge-tools.ts:483).
      const broad = un<ContextData>(
        await registry.dispatch("vault_context", { vault: "main" }, ctxFor(broadAcl)),
      );
      expect(broad.notes.map((n) => n.path).sort()).toEqual(["public/a.md", "secret/b.md"]);
      const writtenFile = prewarmPathFor(dir, "main", broadFp);
      expect(existsSync(writtenFile)).toBe(true);

      // A DIFFERENT caller, same vault, same fresh signal — a NARROW ACL that excludes
      // secret/b.md. On unfixed code this hits the SAME shared cache file and returns the
      // secret path verbatim; the fix must never let that happen.
      const narrow = un<ContextData>(
        await registry.dispatch("vault_context", { vault: "main" }, ctxFor(narrowAcl)),
      );
      const narrowPaths = narrow.notes.map((n) => n.path);
      expect(narrowPaths).not.toContain("secret/b.md");
      expect(narrowPaths).toEqual(["public/a.md"]);
      // Every chunk's content returned to the narrow caller must also be clean — a leak could
      // hide inside a note that IS allowed if grouping ever mixed sources (defence in depth).
      const allContent = narrow.notes.flatMap((n) => n.chunks.map((c) => c.content ?? ""));
      expect(allContent.join(" ")).not.toMatch(/SECRET/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("layer 3 (re-filter on read): a bundle with a matching key but a disallowed path is a full miss, not a partial return", async () => {
    const db = cacheDb();
    const dir = mkdtempSync(join(tmpdir(), "obtc-pwacl-layer3-"));
    try {
      const { registry, ctxFor } = harness(db, dir);
      // Hand-craft an entry keyed EXACTLY as the narrow caller would look it up (correct
      // fingerprint, correct generation) but whose bundle still carries the forbidden secret
      // path — modelling a bug elsewhere that let it in despite a correct cache key.
      const gen = readGeneration(db, "main");
      writePrewarm(prewarmPathFor(dir, "main", narrowFp), {
        generated_at: NOW,
        expires_at: NOW + 60_000,
        signal: "memory/_next-session.md",
        signal_hash: SIGNAL_HASH,
        empty: false,
        acl_fingerprint: narrowFp,
        vault_generation: gen,
        bundle: {
          notes: [
            { path: "public/a.md", chunks: [{ chunk_id: "pub1", content: "fine" }] },
            { path: "secret/b.md", chunks: [{ chunk_id: "sec1", content: "SECRET" }] },
          ],
          lessons: [],
        },
      });
      const res = un<ContextData>(
        await registry.dispatch(
          "vault_context",
          { vault: "main" },
          { ...ctxFor(narrowAcl), now: () => NOW + 1 },
        ),
      );
      // Never the crafted partial-leak bundle: either a live recompose (prefetched undefined)
      // whose notes exclude secret/b.md, or — never — the cached bundle verbatim.
      expect(res.notes.map((n) => n.path)).not.toContain("secret/b.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("staleness test: a source note change without touching the signal note is not served", async () => {
    const db = cacheDb();
    const dir = mkdtempSync(join(tmpdir(), "obtc-pwacl-stale-"));
    try {
      const { registry, ctxFor } = harness(db, dir);
      const first = un<ContextData>(
        await registry.dispatch("vault_context", { vault: "main" }, ctxFor(broadAcl)),
      );
      expect(first.notes.map((n) => n.path)).toContain("public/a.md");

      // Mutate a source note's content (simulating an edit/delete reaching the index) WITHOUT
      // touching _next-session.md, and bump the generation as the real index-write path would.
      db.prepare("DELETE FROM chunks WHERE id = 'pub1'").run();
      bumpGeneration(db, "main");

      const second = un<ContextData>(
        await registry.dispatch("vault_context", { vault: "main" }, ctxFor(broadAcl)),
      );
      // A stale hit would still show pub1's old content; the generation bump must force a live
      // recompose that reflects the deletion.
      expect(second.prefetched).toBeUndefined();
      expect(second.notes.map((n) => n.path)).not.toContain("public/a.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cache still works: same principal, same generation, unchanged signal is still a hit", async () => {
    const db = cacheDb();
    const dir = mkdtempSync(join(tmpdir(), "obtc-pwacl-hit-"));
    try {
      const { registry, ctxFor } = harness(db, dir);
      const first = un<ContextData>(
        await registry.dispatch("vault_context", { vault: "main" }, ctxFor(broadAcl)),
      );
      expect(first.prefetched).toBeUndefined(); // first call composes live and writes through

      const second = un<ContextData>(
        await registry.dispatch("vault_context", { vault: "main" }, ctxFor(broadAcl)),
      );
      expect(second.prefetched).toBe(true); // second call, nothing changed -> served from cache
      expect(second.notes.map((n) => n.path).sort()).toEqual(first.notes.map((n) => n.path).sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pre-migration degradation: no vault_generation table -> readGeneration is 0 and nothing throws", async () => {
    const db = openMemoryDb();
    // Provision every migration EXCEPT vault_generation, so hasVaultGeneration(db) is false —
    // the pre-migration cache.db shape THE-496's readGeneration/bumpGeneration degrade for.
    provisionCacheDb(db);
    db.exec("DROP TABLE vault_generation");
    const ins = db.prepare(
      "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, 'main', ?, ?, '[]', ?, ?, ?, ?, ?)",
    );
    ins.run(
      "pub1",
      "public/a.md",
      "0",
      `the ${RARE_TERM} pattern, public copy`,
      "hp",
      40,
      NOW,
      NOW,
    );
    ensureChunkFts(db, { now: () => NOW, enrich: false });

    const dir = mkdtempSync(join(tmpdir(), "obtc-pwacl-premig-"));
    try {
      expect(() => readGeneration(db, "main")).not.toThrow();
      expect(readGeneration(db, "main")).toBe(0);

      const { registry, ctxFor } = harness(db, dir);
      const first = await registry.dispatch("vault_context", { vault: "main" }, ctxFor(broadAcl));
      expect((first as { ok: boolean }).ok).toBe(true);
      const second = un<ContextData>(
        await registry.dispatch("vault_context", { vault: "main" }, ctxFor(broadAcl)),
      );
      // Generation stays 0 -> 0 forever pre-migration; the fingerprint + signal-hash halves of
      // the key still work, so the cache still serves a hit rather than silently disabling.
      expect(second.prefetched).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("both writers: the CLI scheduled-prefetch writer (cli.ts) keys its entry the same way and cannot leak to a narrower live caller", async () => {
    const cliDir = mkdtempSync(join(tmpdir(), "obtc-pwacl-cli-"));
    const vaultDir = join(cliDir, "vault");
    const cacheDirPath = join(cliDir, "cache");
    mkdirSync(join(vaultDir, "memory"), { recursive: true });
    mkdirSync(join(vaultDir, "public"), { recursive: true });
    mkdirSync(join(vaultDir, "secret"), { recursive: true });
    writeFileSync(join(vaultDir, "memory", "_next-session.md"), SIGNAL_TEXT);
    writeFileSync(join(vaultDir, "public", "a.md"), `the ${RARE_TERM} pattern, public copy`);
    writeFileSync(join(vaultDir, "secret", "b.md"), `the ${RARE_TERM} pattern, SECRET copy`);

    // Pre-provision cache.db with the same two chunks (bypasses needing a real embedding
    // backend for `obsidian-tc index`) and the retrieval.classRouter config the lexical route
    // needs.
    mkdirSync(cacheDirPath, { recursive: true });
    const { DatabaseSync } = await import("node:sqlite");
    const fileDb = new DatabaseSync(join(cacheDirPath, "cache.db")) as unknown as Database;
    provisionCacheDb(fileDb);
    const ins = fileDb.prepare(
      "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, 'main', ?, ?, '[]', ?, ?, ?, ?, ?)",
    );
    ins.run(
      "pub1",
      "public/a.md",
      "0",
      `the ${RARE_TERM} pattern, public copy`,
      "hp",
      40,
      NOW,
      NOW,
    );
    ins.run(
      "sec1",
      "secret/b.md",
      "0",
      `the ${RARE_TERM} pattern, SECRET copy`,
      "hs",
      40,
      NOW,
      NOW,
    );
    ensureChunkFts(fileDb, { now: () => Date.now(), enrich: false });
    fileDb.close?.();

    const configPath = join(cliDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        vaults: [{ id: "main", path: vaultDir }],
        cacheDir: cacheDirPath,
        retrieval: { classRouter: true },
      }),
    );

    const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
    try {
      if (!bunAvailable) {
        // Environment without `bun` on PATH cannot exercise the real subprocess; skip rather
        // than silently pass.
        return;
      }
      const r = spawnSync("bun", [CLI, "prefetch", configPath], {
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, NO_COLOR: "1" },
      });
      expect(r.status).toBe(0);

      // The CLI's writer used the trusted, unbound (no-ACL) context — its cache identity must
      // be the same "no-acl" sentinel the live path uses for an unbound caller, and its file
      // must carry the acl_fingerprint + vault_generation fields.
      const noAclFp = callerAclFingerprint(undefined, GRANTED);
      const writtenPath = prewarmPathFor(cacheDirPath, "main", noAclFp);
      expect(existsSync(writtenPath)).toBe(true);
      const written = JSON.parse(readFileSync(writtenPath, "utf8")) as PrewarmEntry;
      expect(written.acl_fingerprint).toBe(noAclFp);
      expect(typeof written.vault_generation).toBe("number");
      // The trusted CLI context saw both notes (no ACL bound).
      const bundleNotes = (written.bundle?.notes as Array<{ path: string }> | undefined) ?? [];
      expect(bundleNotes.map((n) => n.path).sort()).toEqual(["public/a.md", "secret/b.md"]);

      // A live, narrow-ACL caller reading the SAME prewarmDir must never inherit this entry.
      const db = new DatabaseSync(join(cacheDirPath, "cache.db")) as unknown as Database;
      try {
        const { registry, ctxFor } = harness(db, cacheDirPath);
        const narrow = un<ContextData>(
          await registry.dispatch("vault_context", { vault: "main" }, ctxFor(narrowAcl)),
        );
        expect(narrow.notes.map((n) => n.path)).not.toContain("secret/b.md");
      } finally {
        db.close?.();
      }
    } finally {
      rmSync(cliDir, { recursive: true, force: true });
    }
  }, 60_000);
});
