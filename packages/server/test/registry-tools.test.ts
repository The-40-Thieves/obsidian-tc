import { describe, expect, it } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { argsHash } from "../src/hash";
import { makeTestVault } from "./m1-helpers";

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
          "INSERT INTO idempotency_keys (vault_id, key, tool_name, args_hash, started_at, expires_at) VALUES (?,?,?,?,?,?)",
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
});
