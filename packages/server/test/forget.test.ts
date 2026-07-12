// THE-239 — dependency-aware deletion pins. The hash chain breaks on tamper; episode forget
// tombstones always and scrubs content only in erase mode (row skeleton survives for the
// attribution chain); note forget clears derived state (activation always, retrieval history
// only under erase — the audit default KEEPS it), invalidates a prewarm bundle that mentions
// the target, and reports (never mutates) syntheses/contradictions/reflections.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import {
  appendForgetLog,
  forgetEpisode,
  forgetNote,
  verifyForgetLog,
} from "../src/experiential/forget";
import { openMemoryDb } from "./helpers";

const sql = (p: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${p}`, import.meta.url)), "utf8");
const schemaSql = readFileSync(
  fileURLToPath(new URL("../src/schema.sql", import.meta.url)),
  "utf8",
);
const NOW = 1_700_000_000_000;

function edb0(): Database {
  const db = openMemoryDb();
  runMigrations(db, [
    { version: "20260626_001", sql: sql("20260626_001_experiential_init.sql") },
    { version: "20260711_001", sql: sql("20260711_001_experiential_outcome.sql") },
    { version: "20260711_002", sql: sql("20260711_002_agent_episodes.sql") },
    { version: "20260712_001", sql: sql("20260712_001_preference_profile.sql") },
    { version: "20260712_003", sql: sql("20260712_003_forget_log.sql") },
  ]);
  return db;
}

const dir = mkdtempSync(join(tmpdir(), "obtc-forget-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("forget_log hash chain (THE-239)", () => {
  it("verifies clean chains and detects tampering", () => {
    const edb = edb0();
    appendForgetLog(edb, {
      ts: NOW,
      kind: "episode",
      target: "e1",
      mode: "tombstone",
      details: {},
    });
    appendForgetLog(edb, {
      ts: NOW + 1,
      kind: "note",
      target: "a.md",
      mode: "erase",
      details: { chunks: 2 },
    });
    expect(verifyForgetLog(edb)).toEqual({ ok: true, entries: 2 });
    edb.prepare("UPDATE forget_log SET target = 'evil.md' WHERE seq = 1").run();
    const broken = verifyForgetLog(edb);
    expect(broken.ok).toBe(false);
    expect(broken.breakAt).toBe(1);
  });
});

describe("forgetEpisode", () => {
  function seedEpisode(edb: Database, id: string): void {
    edb
      .prepare(
        `INSERT INTO agent_episodes (id, ts, caller, channel, episode_type, tool, status, args_json, summary, eligibility, blocked, valid_from)
         VALUES (?, ?, 'alice', 'dispatch', 'tool_call', 'read_note', 'ok', '{"secret":1}', 'did a thing', 'eligible', 0, ?)`,
      )
      .run(id, NOW, NOW);
  }

  it("tombstones by default, keeping content; erase scrubs content but keeps the skeleton", () => {
    const edb = edb0();
    seedEpisode(edb, "e1");
    seedEpisode(edb, "e2");
    const t = forgetEpisode(edb, "e1", { nowMs: NOW + 10 });
    expect(t.found).toBe(true);
    const r1 = edb
      .prepare("SELECT blocked, valid_until, args_json FROM agent_episodes WHERE id='e1'")
      .get() as { blocked: number; valid_until: number; args_json: string | null };
    expect(r1.blocked).toBe(1);
    expect(r1.valid_until).toBe(NOW + 10);
    expect(r1.args_json).toBe('{"secret":1}'); // audit mode keeps content

    const e = forgetEpisode(edb, "e2", { nowMs: NOW + 20, erase: true });
    expect(e.scrubbed_fields).toBe(1);
    const r2 = edb
      .prepare("SELECT id, caller, blocked, args_json, summary FROM agent_episodes WHERE id='e2'")
      .get() as { id: string; caller: string; blocked: number; args_json: null; summary: null };
    expect(r2.blocked).toBe(1);
    expect(r2.args_json).toBeNull();
    expect(r2.summary).toBeNull();
    expect(r2.caller).toBe("alice"); // skeleton + attribution survive
    expect(verifyForgetLog(edb).entries).toBe(2);
  });

  it("missing episode is a no-op with no log entry; repeat forget is idempotent", () => {
    const edb = edb0();
    expect(forgetEpisode(edb, "nope", { nowMs: NOW }).found).toBe(false);
    expect(verifyForgetLog(edb).entries).toBe(0);
    seedEpisode(edb, "e1");
    forgetEpisode(edb, "e1", { nowMs: NOW });
    const again = forgetEpisode(edb, "e1", { nowMs: NOW + 1 });
    expect(again.already_blocked).toBe(true);
    expect(verifyForgetLog(edb).entries).toBe(2); // both audited, chain intact
  });
});

describe("forgetNote", () => {
  function rig() {
    const edb = edb0();
    const cache = openMemoryDb();
    cache.exec(schemaSql);
    const ins = cache.prepare(
      "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, 'main', ?, 0, '[]', 'c', ?, 10, ?, ?)",
    );
    ins.run("t1", "notes/target.md", "h1", NOW, NOW);
    ins.run("t2", "notes/target.md", "h2", NOW, NOW);
    ins.run("k1", "notes/keep.md", "h3", NOW, NOW);
    const hit = edb.prepare(
      "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, surface_type, query_text, rank_in_results) VALUES (?, ?, ?, 's', 'q', 1)",
    );
    hit.run("r1", "t1", NOW);
    hit.run("r2", "t2", NOW);
    hit.run("r3", "k1", NOW);
    edb
      .prepare(
        "INSERT INTO vault_object_state (object_id, frequency, last_accessed) VALUES ('t1', 2, ?)",
      )
      .run(NOW);
    return { edb, cache };
  }

  it("audit default keeps retrieval history; erase deletes it; activation always cleared", () => {
    const a = rig();
    const audit = forgetNote(a.edb, a.cache, {
      vaultId: "main",
      relPath: "notes/target.md",
      nowMs: NOW + 5,
    });
    expect(audit.chunk_ids.sort()).toEqual(["t1", "t2"]);
    expect(audit.retrieval_rows).toBe(2);
    expect(audit.retrieval_rows_deleted).toBe(0); // audit keeps
    expect(audit.activation_rows_deleted).toBe(1);
    expect(
      (a.edb.prepare("SELECT COUNT(*) AS n FROM chunk_retrievals").get() as { n: number }).n,
    ).toBe(3);

    const b = rig();
    const erase = forgetNote(b.edb, b.cache, {
      vaultId: "main",
      relPath: "notes/target.md",
      nowMs: NOW + 5,
      erase: true,
    });
    expect(erase.retrieval_rows_deleted).toBe(2);
    // untouched note's history survives an erase of its neighbor
    expect(
      (b.edb.prepare("SELECT COUNT(*) AS n FROM chunk_retrievals").get() as { n: number }).n,
    ).toBe(1);
    expect(verifyForgetLog(b.edb)).toEqual({ ok: true, entries: 1 });
  });

  it("invalidates a prewarm bundle mentioning the target and reports reflections", () => {
    const { edb, cache } = rig();
    const prewarmDir = join(dir, "warm");
    mkdirSync(prewarmDir, { recursive: true });
    writeFileSync(
      join(prewarmDir, "prewarm-main.json"),
      JSON.stringify({ bundle: { notes: [{ path: "notes/target.md" }] } }),
    );
    const vaultRoot = join(dir, "vault");
    mkdirSync(join(vaultRoot, "memory", "reflections"), { recursive: true });
    writeFileSync(
      join(vaultRoot, "memory", "reflections", "2026-07-12-thing.md"),
      '---\nsource_paths: ["notes/target.md"]\n---\nderived text',
    );
    writeFileSync(
      join(vaultRoot, "memory", "reflections", "unrelated.md"),
      '---\nsource_paths: ["notes/other.md"]\n---\n',
    );
    const res = forgetNote(edb, cache, {
      vaultId: "main",
      relPath: "notes/target.md",
      nowMs: NOW,
      prewarmDir,
      vaultRoot,
    });
    expect(res.prewarm_invalidated).toBe(true);
    expect(res.outdated_reflections).toEqual(["2026-07-12-thing.md"]);
  });
});
