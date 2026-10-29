import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { argsHash } from "../src/hash";
import { insertEntity, insertRelation } from "../src/memory/entities";
import { appendProvenance } from "../src/provenance/store";
import { makeTestVault } from "./m1-helpers";
import { makeTempDir, rmTemp } from "./tmp";

describe("Domain 1: multi-vault registry", () => {
  it("list_vaults returns configured vaults", async () => {
    const v = makeTestVault();
    try {
      const r = await v.call("list_vaults", {});
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { vaults: Array<{ id: string; chunk_count: number }> };
        expect(d.vaults).toHaveLength(1);
        expect(d.vaults[0]?.id).toBe("test");
        expect(d.vaults[0]?.chunk_count).toBe(0);
      }
    } finally {
      v.cleanup();
    }
  });

  it("THE-924: a vaultBound caller sees only its own vault; an unbound caller sees all", async () => {
    const v = makeTestVault();
    const dir = makeTempDir("obtc-vaultbound-");
    try {
      const add = await v.call("add_vault", { vault_id: "other", path: dir });
      expect(add.ok).toBe(true);

      const unbound = await v.call("list_vaults", {});
      expect(unbound.ok).toBe(true);
      if (unbound.ok) {
        const ids = (unbound.data as { vaults: Array<{ id: string }> }).vaults.map((x) => x.id);
        expect(ids.sort()).toEqual(["other", "test"]);
      }

      const bound = await v.call("list_vaults", {}, { vaultBound: true, vaultId: "test" });
      expect(bound.ok).toBe(true);
      if (bound.ok) {
        const d = bound.data as { vaults: Array<{ id: string; path: string }> };
        expect(d.vaults).toHaveLength(1);
        expect(d.vaults[0]?.id).toBe("test");
        // Must not leak the other vault's id or absolute path.
        expect(d.vaults.some((x) => x.id === "other")).toBe(false);
        expect(d.vaults.some((x) => x.path === dir)).toBe(false);
      }
    } finally {
      v.cleanup();
      rmTemp(dir);
    }
  });

  it("get_vault reports acl and 404s an unknown vault", async () => {
    const v = makeTestVault({ acl: { writePaths: ["notes/**"] } });
    try {
      const ok = await v.call("get_vault", { vault: "test" });
      expect(ok.ok).toBe(true);
      if (ok.ok) {
        const d = ok.data as { acl: { write_paths: string[] | null } };
        expect(d.acl.write_paths).toEqual(["notes/**"]);
      }
      const bad = await v.call("get_vault", { vault: "missing" });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error.code).toBe("vault_not_found");
    } finally {
      v.cleanup();
    }
  });

  it("reload_vault returns a timestamp", async () => {
    const v = makeTestVault();
    try {
      const r = await v.call("reload_vault", { vault: "test" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { reloaded_at: string };
        expect(typeof d.reloaded_at).toBe("string");
      }
    } finally {
      v.cleanup();
    }
  });

  it("reset_vault_cache gates on HITL, then drops rows", async () => {
    const v = makeTestVault();
    try {
      v.db
        .prepare(
          "INSERT INTO idempotency_keys (vault_id, principal, idem_key, tool_name, args_hash, started_at, expires_at) VALUES (?,'t',?,?,?,?,?)",
        )
        .run("test", "k1", "write_note", "h", 1, 9999999999999);

      const need = await v.call("reset_vault_cache", { vault: "test" });
      expect(need.ok).toBe(false);
      if (!need.ok) expect(need.error.code).toBe("elicit_required");

      const token = issueElicitToken(v.db, {
        vaultId: "test",
        toolName: "reset_vault_cache",
        argsHash: argsHash("reset_vault_cache", { vault: "test" }),
        caller: "test",
      });
      const ok = await v.call("reset_vault_cache", { vault: "test" }, { elicitToken: token });
      expect(ok.ok).toBe(true);
      if (ok.ok) {
        const d = ok.data as { rows_dropped: { idempotency_keys: number } };
        expect(d.rows_dropped.idempotency_keys).toBe(1);
      }
      // reuse of the consumed token is rejected
      const reuse = await v.call("reset_vault_cache", { vault: "test" }, { elicitToken: token });
      expect(reuse.ok).toBe(false);
      if (!reuse.ok) expect(reuse.error.code).toBe("elicit_required");
    } finally {
      v.cleanup();
    }
  });

  it.each([false, true])(
    "reset_vault_cache preserves durable state (explicit index-only flags: %s)",
    async (indexOnly) => {
      const projection = "# Ada\n\nMaterialized memory projection\n";
      const v = makeTestVault({ files: { "memory/person/Ada.md": projection } });
      try {
        const ada = insertEntity(v.db, {
          vaultId: "test",
          entityType: "person",
          name: "Ada",
          observations: ["Maintains the project"],
          materialize: true,
          vaultPath: "memory/person/Ada.md",
          now: 1000,
        });
        const project = insertEntity(v.db, {
          vaultId: "test",
          entityType: "project",
          name: "Archive",
          materialize: false,
          now: 1000,
        });
        insertRelation(v.db, ada.id, project.id, "maintains", 1000);
        appendProvenance(
          v.db,
          {
            vaultId: "test",
            ts: 1000,
            tool: "write_note",
            outcome: "ok",
            paths: [{ path: "memory/person/Ada.md", before: "absent", after: "f".repeat(64) }],
            pathsOmitted: 0,
            verified: { host: "fixture", server_version: "test" },
            unauthenticated: {},
            self_reported: {},
          },
          undefined,
        );
        const durableTables = [
          "memory_entities",
          "memory_relations",
          "memory_observation_intervals",
          "write_provenance",
          "write_provenance_heads",
        ];
        const durableState = () =>
          durableTables.map((table) => v.db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all());
        const before = durableState();
        for (const rows of before) expect(rows.length).toBeGreaterThan(0);
        v.db
          .prepare(
            "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            "chunk",
            "test",
            "memory/person/Ada.md",
            "0",
            "[]",
            projection,
            "hash",
            5,
            1000,
            1000,
          );
        v.db
          .prepare(
            "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?,?,?,?,?,?)",
          )
          .run("chunk", "fake:old", 2, new Uint8Array(Float32Array.from([1, 0]).buffer), 1, 1000);
        v.db
          .prepare(
            "INSERT INTO idempotency_keys (vault_id, principal, idem_key, tool_name, args_hash, started_at, expires_at) VALUES (?,'t',?,?,?,?,?)",
          )
          .run("test", "preserve", "write_note", "h", 1, 9999999999999);
        const input = {
          vault: "test",
          ...(indexOnly
            ? {
                include: {
                  chunks: true,
                  embeddings: true,
                  idempotency_keys: false,
                  event_log: false,
                  capture_committed: false,
                },
              }
            : {}),
        };
        const need = await v.call("reset_vault_cache", input);
        expect(need.ok).toBe(false);
        if (!need.ok) expect(need.error.code).toBe("elicit_required");
        const token = issueElicitToken(v.db, {
          vaultId: "test",
          toolName: "reset_vault_cache",
          argsHash: argsHash("reset_vault_cache", input),
          caller: "test",
        });
        const reset = await v.call("reset_vault_cache", input, { elicitToken: token });
        expect(reset.ok).toBe(true);
        expect(v.db.prepare("SELECT id FROM chunks").all()).toEqual([]);
        expect(v.db.prepare("SELECT chunk_id FROM chunk_embeddings").all()).toEqual([]);
        expect(durableState()).toEqual(before);
        expect(v.read("memory/person/Ada.md")).toBe(projection);
        expect(v.db.prepare("SELECT idem_key FROM idempotency_keys").all()).toEqual(
          indexOnly ? [{ idem_key: "preserve" }] : [],
        );
      } finally {
        v.cleanup();
      }
    },
  );
});

describe("THE-376 add_vault (runtime registration)", () => {
  it("registers a new vault at runtime, usable immediately; rejects dup id + missing path", async () => {
    const v = makeTestVault();
    const dir = makeTempDir("obtc-addvault-");
    writeFileSync(join(dir, "hello.md"), "hi");
    try {
      const add = await v.call("add_vault", { vault_id: "extra", path: dir });
      expect(add.ok).toBe(true);

      const list = await v.call("list_vaults", {});
      if (list.ok) {
        const ids = (list.data as { vaults: Array<{ id: string }> }).vaults.map((x) => x.id);
        expect(ids).toContain("extra");
      }

      // filesystem tools work against the new vault immediately (no index needed)
      const read = await v.call("read_note", { vault: "extra", path: "hello.md" });
      expect(read.ok).toBe(true);
      if (read.ok) expect((read.data as { content: string }).content).toBe("hi");

      const dup = await v.call("add_vault", { vault_id: "extra", path: dir });
      expect(dup.ok).toBe(false);
      if (!dup.ok) expect(dup.error.code).toBe("invalid_input");

      const bad = await v.call("add_vault", { vault_id: "ghost", path: join(dir, "nope") });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error.code).toBe("invalid_input");
    } finally {
      rmTemp(dir);
      v.cleanup();
    }
  });
});
