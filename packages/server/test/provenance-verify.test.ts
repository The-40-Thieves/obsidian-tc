// Tamper evidence for the write-provenance chain. Every case edits the SQLite rows directly, the way
// an attacker with file access to cache.db would, and asserts `verifyProvenance` names what was done.
// The chain is per vault, signed per record with the auth registry's EdDSA key, and pinned by a
// signed head row (which is what makes a removed LAST record visible).
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/hash";
import { registrySignerSource } from "../src/provenance/signer";
import { appendProvenance, headMessage, recordMessage } from "../src/provenance/store";
import { verifyProvenance } from "../src/provenance/verify";
import { CLOCK0, provenanceFixture, rowsFor } from "./provenance-helpers";

type Fx = Awaited<ReturnType<typeof provenanceFixture>>;

const digest = (c: string) => createHash("sha256").update(c).digest("hex");
const VAULT = "v1";

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("expected a value");
  return v;
}

function seed(fx: Fx, n: number, vault = VAULT): void {
  const signer = registrySignerSource(fx.registry)();
  for (let i = 1; i <= n; i++) {
    appendProvenance(
      fx.db,
      {
        vaultId: vault,
        ts: CLOCK0 + i,
        tool: `tool_${i}`,
        outcome: "ok",
        paths: [{ path: `n${i}.md`, before: "absent", after: digest(`c${i}`) }],
        pathsOmitted: 0,
        verified: { host: "h", server_version: "0" },
        unauthenticated: {},
        self_reported: {},
      },
      signer,
    );
  }
}

const verify = (fx: Fx, allowUnsigned = false) =>
  must(verifyProvenance(fx.db, { resolveKey: fx.resolveKey(), allowUnsigned }, VAULT)[0]);
const codes = (r: ReturnType<typeof verify>) => r.problems.map((p) => p.code);

describe("provenance verify: an intact chain", () => {
  it("verifies, counting every record as signed", async () => {
    const fx = await provenanceFixture();
    seed(fx, 4);
    const r = verify(fx);
    expect(r).toMatchObject({ ok: true, records: 4, signed: 4, unsigned: 0, problems: [] });
  });

  it("a vault with no chain verifies as zero records", async () => {
    const fx = await provenanceFixture();
    expect(verify(fx)).toMatchObject({ ok: true, records: 0 });
  });
});

describe("provenance verify: RED cases", () => {
  it("a tampered field is a hash_mismatch at that record", async () => {
    const fx = await provenanceFixture();
    seed(fx, 3);
    const row = must(rowsFor(fx.db)[1]);
    fx.db
      .prepare("UPDATE write_provenance SET body = ? WHERE seq = 2")
      .run(row.body.replace("tool_2", "tool_X"));
    const r = verify(fx);
    expect(r.ok).toBe(false);
    expect(r.problems).toContainEqual(expect.objectContaining({ code: "hash_mismatch", seq: 2 }));
  });

  it("a removed middle record is a seq_gap and a chain_break", async () => {
    const fx = await provenanceFixture();
    seed(fx, 3);
    fx.db.prepare("DELETE FROM write_provenance WHERE seq = 2").run();
    const r = verify(fx);
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(expect.arrayContaining(["seq_gap", "chain_break"]));
  });

  it("a removed LAST record is caught by the signed head, not the chain", async () => {
    const fx = await provenanceFixture();
    seed(fx, 3);
    fx.db.prepare("DELETE FROM write_provenance WHERE seq = 3").run();
    const r = verify(fx);
    expect(r.ok).toBe(false);
    // The records that remain are a perfectly valid chain: only the head row knows one is missing.
    expect(codes(r)).toEqual(["head_mismatch"]);
  });

  it("removing the last record AND the head row is head_missing, not silence", async () => {
    const fx = await provenanceFixture();
    seed(fx, 3);
    fx.db.prepare("DELETE FROM write_provenance WHERE seq = 3").run();
    fx.db.prepare("DELETE FROM write_provenance_heads").run();
    const r = verify(fx);
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("head_missing");
  });

  it("rewinding the head row to hide the last record breaks its signature", async () => {
    const fx = await provenanceFixture();
    seed(fx, 3);
    const two = must(rowsFor(fx.db)[1]);
    fx.db.prepare("DELETE FROM write_provenance WHERE seq = 3").run();
    fx.db.prepare("UPDATE write_provenance_heads SET head_seq = 2, head_hash = ?").run(two.hash);
    const r = verify(fx);
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("head_bad_signature");
  });

  it("a reordered record is detected", async () => {
    const fx = await provenanceFixture();
    seed(fx, 3);
    // Swap the positions of records 2 and 3 through a parking value (PRIMARY KEY is (vault, seq)).
    fx.db.prepare("UPDATE write_provenance SET seq = 99 WHERE seq = 2").run();
    fx.db.prepare("UPDATE write_provenance SET seq = 2 WHERE seq = 3").run();
    fx.db.prepare("UPDATE write_provenance SET seq = 3 WHERE seq = 99").run();
    const r = verify(fx);
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(expect.arrayContaining(["column_mismatch", "chain_break"]));
  });

  it("a signature under an unknown kid is unknown_kid", async () => {
    const fx = await provenanceFixture();
    seed(fx, 2);
    fx.db.prepare("UPDATE write_provenance SET kid = 'never-held' WHERE seq = 2").run();
    const r = verify(fx);
    expect(r.ok).toBe(false);
    expect(r.problems).toContainEqual(expect.objectContaining({ code: "unknown_kid", seq: 2 }));
  });

  it("a signature made by a key outside the registry does not verify", async () => {
    const fx = await provenanceFixture();
    seed(fx, 2);
    const kid = (rowsFor(fx.db)[1] as { kid: string }).kid;
    const { privateKey } = generateKeyPairSync("ed25519");
    const row = must(rowsFor(fx.db)[1]);
    const forged = sign(null, Buffer.from(recordMessage(row.hash)), privateKey).toString(
      "base64url",
    );
    fx.db.prepare("UPDATE write_provenance SET sig = ?, kid = ? WHERE seq = 2").run(forged, kid);
    expect(verify(fx).problems).toContainEqual(
      expect.objectContaining({ code: "bad_signature", seq: 2 }),
    );
  });

  it("re-signed but chain-broken: a rewritten record with a valid hash and signature still breaks the next link", async () => {
    const fx = await provenanceFixture();
    seed(fx, 3);
    const signer = must(registrySignerSource(fx.registry)());
    const row = must(rowsFor(fx.db)[1]);
    // The attacker edits record 2's body, recomputes its hash, and signs it with a VALID key
    // (they hold the key), so record 2 alone checks out in every respect.
    const body = JSON.parse(row.body);
    body.tool = "innocent_tool";
    const text = canonicalJson(body);
    const hash = createHash("sha256").update(text, "utf8").digest("hex");
    fx.db
      .prepare("UPDATE write_provenance SET body = ?, hash = ?, sig = ?, kid = ? WHERE seq = 2")
      .run(text, hash, signer.sign(recordMessage(hash)), signer.kid);
    const r = verify(fx);
    expect(r.ok).toBe(false);
    expect(r.problems.filter((p) => p.seq === 2)).toEqual([]);
    // Record 3 still points at record 2's ORIGINAL hash.
    expect(r.problems).toContainEqual(expect.objectContaining({ code: "chain_break", seq: 3 }));
  });

  it("re-signing the whole tail too leaves the head pointing at the old last record", async () => {
    const fx = await provenanceFixture();
    seed(fx, 3);
    const signer = must(registrySignerSource(fx.registry)());
    const rows = rowsFor(fx.db);
    let prev = "";
    for (const row of rows.slice(1)) {
      const body = JSON.parse(row.body);
      if (row.seq === 2) body.tool = "innocent_tool";
      else body.prev = prev;
      const text = canonicalJson(body);
      const hash = createHash("sha256").update(text, "utf8").digest("hex");
      fx.db
        .prepare(
          "UPDATE write_provenance SET body = ?, hash = ?, prev_hash = ?, sig = ?, kid = ? WHERE seq = ?",
        )
        .run(text, hash, body.prev, signer.sign(recordMessage(hash)), signer.kid, row.seq);
      prev = hash;
    }
    const r = verify(fx);
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(["head_mismatch"]);
  });

  it("an unsigned record fails verification unless --allow-unsigned", async () => {
    const fx = await provenanceFixture({ signed: false });
    seed(fx, 2);
    const strict = verify(fx);
    expect(strict.ok).toBe(false);
    expect(strict).toMatchObject({ records: 2, signed: 0, unsigned: 2 });
    expect(codes(strict)).toEqual(expect.arrayContaining(["unsigned", "head_unsigned"]));
    const lax = verify(fx, true);
    expect(lax.ok).toBe(true);
    // The problems are still REPORTED under allowUnsigned; they just do not fail the run.
    expect(codes(lax)).toContain("unsigned");
  });

  it("stripping a signature off a signed record is an unsigned record, not a pass", async () => {
    const fx = await provenanceFixture();
    seed(fx, 2);
    fx.db.prepare("UPDATE write_provenance SET sig = NULL, kid = NULL WHERE seq = 1").run();
    const r = verify(fx);
    expect(r.ok).toBe(false);
    expect(r.problems).toContainEqual(expect.objectContaining({ code: "unsigned", seq: 1 }));
  });

  it("allow-unsigned does not excuse a tampered unsigned chain", async () => {
    const fx = await provenanceFixture({ signed: false });
    seed(fx, 3);
    fx.db.prepare("DELETE FROM write_provenance WHERE seq = 2").run();
    expect(verify(fx, true).ok).toBe(false);
  });
});

describe("provenance verify: key rotation", () => {
  it("records signed by a retiring, then retired, key still verify", async () => {
    const fx = await provenanceFixture();
    seed(fx, 2);
    const oldKid = (rowsFor(fx.db)[0] as { kid: string }).kid;

    await fx.rotate(3600); // the old key is now `retiring`
    seed(fx, 2);
    const kids = new Set(rowsFor(fx.db).map((r) => r.kid));
    expect(kids.size).toBe(2);
    expect(verify(fx)).toMatchObject({ ok: true, records: 4, signed: 4 });

    const midKid = (rowsFor(fx.db)[3] as { kid: string }).kid;
    expect(midKid).not.toBe(oldKid);
    await fx.rotate(0); // the key that signed records 3-4 is retired at once
    expect(fx.registry.listKeys().find((k) => k.kid === midKid)?.state).toBe("retired");
    expect(fx.registry.listKeys().find((k) => k.kid === oldKid)?.state).toBe("retiring");
    seed(fx, 1);
    expect(verify(fx)).toMatchObject({ ok: true, records: 5, signed: 5, problems: [] });
  });

  it("the signed head written by a retired key still verifies", async () => {
    const fx = await provenanceFixture();
    seed(fx, 2);
    await fx.rotate(0);
    const head = fx.db.prepare("SELECT * FROM write_provenance_heads").get() as {
      kid: string;
    };
    expect(fx.registry.listKeys().find((k) => k.kid === head.kid)?.state).toBe("retired");
    expect(verify(fx).ok).toBe(true);
  });
});

describe("provenance verify: key material sanity", () => {
  it("the head message covers the prune anchor, so a forged anchor fails the signature", async () => {
    const fx = await provenanceFixture();
    seed(fx, 2);
    const head = fx.db.prepare("SELECT * FROM write_provenance_heads").get() as {
      vault_id: string;
      head_seq: number;
      head_hash: string;
      pruned_seq: number;
      pruned_hash: string;
    };
    expect(headMessage(head)).not.toBe(headMessage({ ...head, pruned_seq: 1 }));
    fx.db
      .prepare("UPDATE write_provenance_heads SET pruned_seq = 1, pruned_hash = ?")
      .run("f".repeat(64));
    // Dropping the prefix (a forged anchor) cannot be re-signed without the key.
    const r = verify(fx);
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("head_bad_signature");
  });
});
