// The reader for `preferred.search_mode` (retrieval.useSearchModePreference, default off): a
// search_vault call that names no mode may take the caller's learned mode instead of `auto`.
//
// Pinned here, at the resolver and through the real dispatch pipeline:
//   * precedence  explicit > preference > default, where an explicit `mode: "auto"` is explicit;
//   * a threshold on the profile weight, and a value that maps onto no search_vault mode is ignored;
//   * caller scoping: the key is caller-scoped, so another principal's row and the shared `''` row
//     of a non-null caller are never read;
//   * a missing / empty / unmigrated profile and a throwing read both fall through to the default;
//   * the diagnostic names the SOURCE of the mode and carries no content.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import type { Database } from "../src/db/types";
import { applyPreferenceDeltas, extractPreferences } from "../src/experiential/reflect";
import {
  resolveSearchVaultMode,
  SEARCH_MODE_MIN_WEIGHT,
} from "../src/experiential/search-mode-preference";
import { openMemoryDb } from "./helpers";
import { makeM2Vault } from "./m2-helpers";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");
const CHAIN = EXPERIENTIAL_MIGRATION_FILES.map((f) => ({ version: versionOf(f), sql: read(f) }));
const NOW = 1_800_000_000_000;
const KEY = "preferred.search_mode";

function edbWith(): Database {
  const edb = openMemoryDb();
  runMigrations(edb, CHAIN);
  return edb;
}

/** Drive `n` agreeing windows for (vault, scopeCaller) through the real upsert, so the weight is
 *  the one the extractor would have produced (1.0, then +0.5 per further agreeing window). */
function seed(edb: Database, vault: string, scopeCaller: string, tool: string, n: number): void {
  for (let i = 0; i < n; i++)
    applyPreferenceDeltas(edb, vault, [{ key: KEY, op: "add", value: tool, scopeCaller }], NOW + i);
}
const STRONG = 1 + Math.ceil((SEARCH_MODE_MIN_WEIGHT - 1) / 0.5); // first window 1.0, +0.5 each

describe("resolveSearchVaultMode", () => {
  let edb: Database;
  beforeEach(() => {
    edb = edbWith();
  });

  it("explicit beats a strong preference (including an explicit auto)", () => {
    seed(edb, "main", "alice", "search_text", STRONG);
    for (const explicit of ["regex", "semantic", "auto"] as const) {
      expect(
        resolveSearchVaultMode({
          explicit,
          stringQuery: true,
          edb,
          vaultId: "main",
          caller: "alice",
        }),
      ).toEqual({ mode: explicit, source: "explicit" });
    }
  });

  it("a strong preference beats the default", () => {
    seed(edb, "main", "alice", "search_text", STRONG);
    expect(
      resolveSearchVaultMode({
        explicit: undefined,
        stringQuery: true,
        edb,
        vaultId: "main",
        caller: "alice",
      }),
    ).toEqual({ mode: "text", source: "preference" });
  });

  it("no profile at all is the default", () => {
    expect(
      resolveSearchVaultMode({
        explicit: undefined,
        stringQuery: true,
        edb,
        vaultId: "main",
        caller: "alice",
      }),
    ).toEqual({ mode: "auto", source: "default" });
  });

  it("threshold: just under the minimum weight is the default, at it is the preference", () => {
    seed(edb, "main", "alice", "search_text", STRONG - 1);
    const weight = (
      edb.prepare("SELECT weight FROM preference_profile").get() as { weight: number }
    ).weight;
    expect(weight).toBeLessThan(SEARCH_MODE_MIN_WEIGHT);
    expect(
      resolveSearchVaultMode({
        explicit: undefined,
        stringQuery: true,
        edb,
        vaultId: "main",
        caller: "alice",
      }).source,
    ).toBe("default");
    seed(edb, "main", "alice", "search_text", 1);
    expect(
      resolveSearchVaultMode({
        explicit: undefined,
        stringQuery: true,
        edb,
        vaultId: "main",
        caller: "alice",
      }).source,
    ).toBe("preference");
  });

  it("a retracted (weight 0) row is never used", () => {
    seed(edb, "main", "alice", "search_text", STRONG);
    applyPreferenceDeltas(
      edb,
      "main",
      [{ key: KEY, op: "retract", scopeCaller: "alice" }],
      NOW + 99,
    );
    expect(
      resolveSearchVaultMode({
        explicit: undefined,
        stringQuery: true,
        edb,
        vaultId: "main",
        caller: "alice",
      }).source,
    ).toBe("default");
  });

  it("a stored tool that maps onto no search_vault mode is the default, not an error", () => {
    for (const tool of [
      "search_regex",
      "search_vault",
      "vault_graph_search",
      "search_omnisearch",
      "x",
    ]) {
      const e = edbWith();
      seed(e, "main", "alice", tool, STRONG);
      expect(
        resolveSearchVaultMode({
          explicit: undefined,
          stringQuery: true,
          edb: e,
          vaultId: "main",
          caller: "alice",
        }),
      ).toEqual({ mode: "auto", source: "default" });
    }
  });

  it("an object query never takes the text preference (text requires a string query)", () => {
    seed(edb, "main", "alice", "search_text", STRONG);
    expect(
      resolveSearchVaultMode({
        explicit: undefined,
        stringQuery: false,
        edb,
        vaultId: "main",
        caller: "alice",
      }),
    ).toEqual({ mode: "auto", source: "default" });
  });

  it("caller scoping: another principal's row is never read", () => {
    seed(edb, "main", "bob", "search_text", STRONG);
    expect(
      resolveSearchVaultMode({
        explicit: undefined,
        stringQuery: true,
        edb,
        vaultId: "main",
        caller: "alice",
      }).source,
    ).toBe("default");
  });

  it("caller scoping: the shared '' row is not read on behalf of a NAMED caller (key is caller-scoped)", () => {
    seed(edb, "main", "", "search_text", STRONG);
    expect(
      resolveSearchVaultMode({
        explicit: undefined,
        stringQuery: true,
        edb,
        vaultId: "main",
        caller: "alice",
      }).source,
    ).toBe("default");
  });

  it("caller scoping: a null caller (unauthenticated stdio) reads the '' partition", () => {
    seed(edb, "main", "", "search_text", STRONG);
    expect(
      resolveSearchVaultMode({
        explicit: undefined,
        stringQuery: true,
        edb,
        vaultId: "main",
        caller: null,
      }),
    ).toEqual({ mode: "text", source: "preference" });
  });

  it("vault scoping: a row for another vault is not read", () => {
    seed(edb, "other", "alice", "search_text", STRONG);
    expect(
      resolveSearchVaultMode({
        explicit: undefined,
        stringQuery: true,
        edb,
        vaultId: "main",
        caller: "alice",
      }).source,
    ).toBe("default");
  });

  it("an unmigrated store and a throwing store both fall through to the default", () => {
    const bare = openMemoryDb();
    expect(
      resolveSearchVaultMode({
        explicit: undefined,
        stringQuery: true,
        edb: bare,
        vaultId: "main",
        caller: "alice",
      }),
    ).toEqual({ mode: "auto", source: "default" });
    const boom = {
      prepare: () => {
        throw new Error("db closed");
      },
    } as unknown as Database;
    expect(
      resolveSearchVaultMode({
        explicit: undefined,
        stringQuery: true,
        edb: boom,
        vaultId: "main",
        caller: "alice",
      }),
    ).toEqual({ mode: "auto", source: "default" });
  });
});

describe("search_vault with the reader wired", () => {
  const files = {
    "fox.md": "# Fox\n\nthe quick brown fox jumps",
    "dog.md": "# Dog\n\nthe lazy dog sleeps",
  };
  async function wired(edb: Database) {
    const v = makeM2Vault({ files, searchModePreference: { edb } });
    await v.call("index_vault", { vault: "test" });
    return v;
  }
  const ok = (r: { ok: boolean; data?: unknown }) => {
    if (!r.ok) throw new Error("expected ok");
    return r.data as { mode_used: string; mode_source?: string; _explain?: { chosen: string } };
  };

  it("omitted mode + strong preference: text is used and the source is 'preference'", async () => {
    const edb = edbWith();
    seed(edb, "test", "test", "search_text", STRONG);
    const v = await wired(edb);
    const d = ok(await v.call("search_vault", { vault: "test", query: "fox" }));
    expect(d.mode_used).toBe("text");
    expect(d.mode_source).toBe("preference");
    v.cleanup();
  });

  it("the preference is text-forced: a query text misses does NOT fall back to semantic", async () => {
    const edb = edbWith();
    seed(edb, "test", "test", "search_text", STRONG);
    const v = await wired(edb);
    const d = ok(await v.call("search_vault", { vault: "test", query: "zzzqqq", explain: true }));
    expect(d.mode_used).toBe("text");
    expect(d._explain?.chosen).toBe("text");
    v.cleanup();
  });

  it("explicit mode wins and is reported as 'explicit'; omitted with no profile is 'default'", async () => {
    const edb = edbWith();
    seed(edb, "test", "test", "search_text", STRONG);
    const v = await wired(edb);
    const a = ok(await v.call("search_vault", { vault: "test", query: "fox", mode: "semantic" }));
    expect(a.mode_used).toBe("semantic");
    expect(a.mode_source).toBe("explicit");
    const b = ok(await v.call("search_vault", { vault: "test", query: "fox", mode: "auto" }));
    expect(b.mode_source).toBe("explicit");
    const c = ok(
      await v.call("search_vault", { vault: "test", query: "fox" }, { caller: "someone-else" }),
    );
    expect(c.mode_source).toBe("default");
    expect(c.mode_used).toBe("text"); // auto -> text first, so the chosen mode coincides; the SOURCE differs
    v.cleanup();
  });

  it("an object query with a strong text preference still routes to jsonlogic", async () => {
    const edb = edbWith();
    seed(edb, "test", "test", "search_text", STRONG);
    const v = await wired(edb);
    const d = ok(await v.call("search_vault", { vault: "test", query: { "==": [1, 1] } }));
    expect(d.mode_used).toBe("jsonlogic");
    expect(d.mode_source).toBe("default");
    v.cleanup();
  });

  it("the diagnostic carries the source only: no path, query or weight text", async () => {
    const edb = edbWith();
    seed(edb, "test", "test", "search_text", STRONG);
    const v = await wired(edb);
    const d = ok(await v.call("search_vault", { vault: "test", query: "fox" }));
    expect(["explicit", "preference", "default"]).toContain(d.mode_source);
    v.cleanup();
  });
});

describe("against the real producer (extractPreferences)", () => {
  const episode = (edb: Database, id: string, caller: string) =>
    edb
      .prepare(
        `INSERT INTO agent_episodes (id, ts, caller, channel, episode_type, tool, status, args_hash, task_result, eligibility, blocked, valid_from, vault_id, session_id, verdict_at, verdict_source)
         VALUES (?, 1, ?, 'dispatch', 'tool_call', 'search_text', 'ok', 'h', 1, 'eligible', 0, 1, 'main', ?, 5, 'operator')`,
      )
      .run(id, caller, `s-${id}`);

  it("a row written for alice steers alice and nobody else", async () => {
    const edb = edbWith();
    episode(edb, "e1", "alice");
    for (let i = 0; i < 5; i++) await extractPreferences(edb, "main", { nowMs: NOW + i });
    const ask = (caller: string | null) =>
      resolveSearchVaultMode({
        explicit: undefined,
        stringQuery: true,
        edb,
        vaultId: "main",
        caller,
      }).source;
    expect(ask("alice")).toBe("preference");
    expect(ask("bob")).toBe("default");
    expect(ask(null)).toBe("default");
  });

  it("KNOWN LIMIT: extraction re-counts unchanged evidence, so weight counts runs, not windows", async () => {
    // One judged window, re-extracted five times, reaches the threshold. This is why extraction is
    // not scheduled behind the flag, and why the threshold is a floor, not a confidence. If
    // extraction becomes idempotent this test must flip, and the docs/config text with it.
    const edb = edbWith();
    episode(edb, "e1", "alice");
    await extractPreferences(edb, "main", { nowMs: NOW });
    const weight = () =>
      (edb.prepare("SELECT weight FROM preference_profile").get() as { weight: number }).weight;
    expect(weight()).toBe(1);
    for (let i = 1; i < 5; i++) await extractPreferences(edb, "main", { nowMs: NOW + i });
    expect(weight()).toBeGreaterThanOrEqual(SEARCH_MODE_MIN_WEIGHT);
  });
});
