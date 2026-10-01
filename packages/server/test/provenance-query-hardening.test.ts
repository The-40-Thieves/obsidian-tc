// get_provenance hardening (review round on the query): every case here is an exploit the review
// of the first cut reproduced, written against the tool as dispatch runs it. Each one must fail on
// the first cut and pass now. Fixtures are real signed chains from the real store.
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../src/hash";
import { queryNoteProvenance } from "../src/provenance/query";
import { sha256Hex } from "../src/provenance/store";
import { moved, queryFixture } from "./provenance-query-helpers";

type Fx = Awaited<ReturnType<typeof queryFixture>>;
const open: Fx[] = [];
const make = async (...a: Parameters<typeof queryFixture>) => {
  const f = await queryFixture(...a);
  open.push(f);
  return f;
};
afterEach(() => {
  for (const f of open.splice(0)) f.cleanup();
});

interface Rec {
  seq: number;
  hash?: string;
  paths?: Array<{ path: string }>;
  paths_truncated?: true;
  verification?: { ok: boolean; signature: string; chain_link: string; problems: string[] };
}
interface Out {
  records: Rec[];
  previous_paths: string[];
  next_cursor: string | null;
  scan_truncated?: true;
  lineage_incomplete?: { reason: string; seq: number };
}
async function data(f: Fx, input: Record<string, unknown>, over = {}): Promise<Out> {
  const r = await f.get(input, over);
  if (!r.ok) throw new Error(`get_provenance failed: ${JSON.stringify(r.error)}`);
  return r.data as Out;
}
const seqs = (o: Out) => o.records.map((r) => r.seq);
const READ_PUB = { readPaths: ["pub/**"] };

describe("RED 1: a record hash is not an oracle for a path the caller cannot read", () => {
  // The review's exploit: seq 1 moves secret/alpha.md (or beta.md) to pub/out.md. The caller sees
  // pub/out.md only, but the stored hash covers the hidden path, so the real source could be
  // found by hashing a candidate body per guess and comparing.
  const hashFor = async (hidden: string) => {
    const f = await make({ acl: READ_PUB });
    f.add({ tool: "move_note", paths: moved(hidden, "pub/out.md") });
    const stored = f.tv.db.prepare("SELECT body, hash FROM write_provenance").get() as {
      body: string;
      hash: string;
    };
    const o = await data(f, { path: "pub/out.md", response_format: "detailed" });
    return { out: o.records[0]?.hash, stored, o };
  };
  const candidateHash = (body: string, hiddenGuess: string) => {
    const b = JSON.parse(body) as { paths: Array<{ path: string }> };
    (b.paths[0] as { path: string }).path = hiddenGuess;
    return sha256Hex(canonicalJson(b));
  };

  it("the returned hash matches no candidate body, including the true one", async () => {
    const { out, stored } = await hashFor("secret/alpha.md");
    expect(out).not.toBe(stored.hash);
    for (const guess of ["secret/alpha.md", "secret/beta.md"]) {
      expect(out).not.toBe(candidateHash(stored.body, guess));
    }
  });

  it("the hash is the same whichever hidden path was really there", async () => {
    const a = await hashFor("secret/alpha.md");
    const b = await hashFor("secret/beta.md");
    expect(a.stored.hash).not.toBe(b.stored.hash); // the stored hashes DO differ...
    expect(a.out).toBe(b.out); // ...what the caller is shown does not
  });

  it("a record with nothing hidden still returns its stored hash", async () => {
    const f = await make({ acl: READ_PUB });
    f.add({ paths: ["pub/a.md"] });
    const stored = (f.tv.db.prepare("SELECT hash FROM write_provenance").get() as { hash: string })
      .hash;
    expect((await data(f, { path: "pub/a.md" })).records[0]?.hash).toBe(stored);
  });
});

describe("RED 2: a tampered record never reports a valid signature", () => {
  const verdict = async (f: Fx, path = "a.md") =>
    (await data(f, { path, include_verification: true })).records[0]?.verification;

  it("the review's exploit: UPDATE body = replace(body, honest, forged)", async () => {
    const f = await make();
    f.add({ paths: ["a.md"], self_reported: { model: "honest" } });
    f.tv.db
      .prepare(
        `UPDATE write_provenance SET body = replace(body, '"honest"', '"forged"') WHERE seq = 1`,
      )
      .run();
    const v = await verdict(f);
    expect(v).toMatchObject({ ok: false, signature: "invalid" });
    expect(v?.problems).toContain("hash_mismatch");
  });

  it("an edited indexed column is not valid either", async () => {
    const f = await make();
    f.add({ paths: ["a.md"] });
    f.tv.db.prepare("UPDATE write_provenance SET ts = ts + 1").run();
    const v = await verdict(f);
    expect(v).toMatchObject({ ok: false, signature: "invalid" });
    expect(v?.problems).toContain("column_mismatch");
  });

  it("an unparseable row is skipped, never trusted, and does not taint its neighbours", async () => {
    const f = await make();
    f.add({ paths: ["a.md"] });
    f.tv.db.prepare("UPDATE write_provenance SET body = body || 'x'").run();
    // an unparseable body cannot be matched to a path, so query through a sibling record
    f.add({ paths: ["a.md"] });
    const o = await data(f, { path: "a.md", include_verification: true });
    expect(o.records.map((r) => r.seq)).toEqual([2]);
    expect(o.records[0]?.verification?.signature).toBe("valid");
  });

  it("a chain break is reported on chain_link and leaves the signature verdict alone", async () => {
    const f = await make();
    f.add({ paths: ["z.md"] });
    f.add({ paths: ["a.md"] });
    f.tv.db.prepare("DELETE FROM write_provenance WHERE seq = 1").run();
    expect(await verdict(f)).toMatchObject({ ok: false, signature: "valid", chain_link: "broken" });
  });
});

describe("RED 3: lineage is followed only through verified move records", () => {
  /** Rewrite one existing row into a plausible move a.md -> b.md, as a database writer without
   *  the signing key could. */
  const forgeMove = (f: Fx, seq: number, recomputeHash: boolean) => {
    const row = f.tv.db.prepare("SELECT body FROM write_provenance WHERE seq = ?").get(seq) as {
      body: string;
    };
    const body = JSON.parse(row.body) as Record<string, unknown>;
    body.tool = "move_note";
    body.paths = moved("a.md", "b.md");
    const text = canonicalJson(body);
    if (recomputeHash) {
      f.tv.db
        .prepare("UPDATE write_provenance SET body = ?, hash = ? WHERE seq = ?")
        .run(text, sha256Hex(text), seq);
    } else {
      f.tv.db.prepare("UPDATE write_provenance SET body = ? WHERE seq = ?").run(text, seq);
    }
  };
  const seedForgeable = (f: Fx) => {
    f.add({ paths: ["a.md"] }); // 1
    f.add({ paths: ["a.md"] }); // 2
    f.add({ paths: ["c.md"] }); // 3 -> rewritten into a move a.md -> b.md
  };

  it("a rewritten body forging a move is not followed, and the walk says why", async () => {
    const f = await make();
    seedForgeable(f);
    forgeMove(f, 3, false);
    const o = await data(f, { path: "b.md" }); // verification NOT requested
    expect(seqs(o)).toEqual([3]);
    expect(o.previous_paths).toEqual([]);
    expect(o.lineage_incomplete).toEqual({ reason: "hash_mismatch", seq: 3 });
  });

  it("a forged move with a recomputed hash fails on its signature", async () => {
    const f = await make();
    seedForgeable(f);
    forgeMove(f, 3, true);
    const o = await data(f, { path: "b.md" });
    expect(seqs(o)).toEqual([3]);
    expect(o.lineage_incomplete?.reason).toBe("bad_signature");
  });

  it("an unsigned row inserted among signed ones is not followed", async () => {
    const f = await make();
    seedForgeable(f);
    forgeMove(f, 3, true);
    f.tv.db.prepare("UPDATE write_provenance SET kid = NULL, sig = NULL WHERE seq = 3").run();
    const o = await data(f, { path: "b.md" });
    expect(seqs(o)).toEqual([3]);
    expect(o.lineage_incomplete?.reason).toBe("unsigned");
  });

  it("signed moves cannot be vouched for without keys: not followed, flagged unverifiable", async () => {
    const f = await make({ provenanceKeys: () => undefined });
    f.add({ paths: ["a.md"] });
    f.add({ tool: "move_note", paths: moved("a.md", "b.md") });
    const o = await data(f, { path: "b.md" });
    expect(seqs(o)).toEqual([2]);
    expect(o.lineage_incomplete).toEqual({ reason: "unverifiable", seq: 2 });
  });

  it("an unsigned deployment (no keys, no signatures) still follows its moves", async () => {
    const f = await make({ signed: false, provenanceKeys: () => undefined });
    f.add({ paths: ["a.md"] });
    f.add({ tool: "move_note", paths: moved("a.md", "b.md") });
    const o = await data(f, { path: "b.md" });
    expect(seqs(o)).toEqual([2, 1]);
    expect(o.previous_paths).toEqual(["a.md"]);
    expect(o.lineage_incomplete).toBeUndefined();
  });

  it("a genuine signed move is followed and raises no flag", async () => {
    const f = await make();
    f.add({ paths: ["a.md"] });
    f.add({ tool: "move_note", paths: moved("a.md", "b.md") });
    const o = await data(f, { path: "b.md" });
    expect(seqs(o)).toEqual([2, 1]);
    expect(o.lineage_incomplete).toBeUndefined();
  });

  it("an unreadable source stops the walk silently (no flag that would say a source exists)", async () => {
    const f = await make({ acl: READ_PUB });
    f.add({ tool: "move_note", paths: moved("secret/a.md", "pub/b.md") });
    const o = await data(f, { path: "pub/b.md" });
    expect(o.lineage_incomplete).toBeUndefined();
  });
});

describe("RED 4: one bounded scan per query", () => {
  const noise = (f: Fx, n: number) => {
    for (let i = 0; i < n; i++) f.add({ paths: [`dir${i}/a.md`] });
  };

  it("examines each row of the chain at most once, lineage and records together", async () => {
    const f = await make();
    f.add({ paths: ["a.md"] }); // 1
    noise(f, 300);
    f.add({ tool: "move_note", paths: moved("a.md", "b.md") });
    noise(f, 300);
    f.add({ tool: "move_note", paths: moved("b.md", "c.md") });
    const r = queryNoteProvenance(f.tv.db, {
      vaultId: f.tv.id,
      path: "c.md",
      readable: () => true,
      limit: 200,
      resolveKey: f.fx.resolveKey(),
      maxScanRows: 1_000_000,
    });
    expect(r.previousPaths).toEqual(["b.md", "a.md"]);
    // One pass over the 603 rows, plus at most one 256-seq range re-read per hop; the first cut
    // read the lineage and then the records, ~2 passes.
    expect(r.rowsExamined).toBeLessThanOrEqual(603 + 2 * 256);
  });

  it("stops at the row budget and says so; what it found stays", async () => {
    const f = await make({ provenanceMaxScanRows: 100 });
    f.add({ paths: ["a.md"] }); // 1, far beyond the budget
    noise(f, 250);
    f.add({ paths: ["a.md"] }); // 252, inside it
    const o = await data(f, { path: "a.md" });
    expect(seqs(o)).toEqual([252]);
    expect(o.scan_truncated).toBe(true);
  });

  it("a chain that fits the budget is not flagged", async () => {
    const f = await make({ provenanceMaxScanRows: 100 });
    f.add({ paths: ["a.md"] });
    noise(f, 10);
    const o = await data(f, { path: "a.md" });
    expect(seqs(o)).toEqual([1]);
    expect(o.scan_truncated).toBeUndefined();
  });
});

describe("RED 5: paths_truncated says nothing about paths the caller cannot read", () => {
  it("a bulk record with a hidden member and omitted paths shows no truncation flag", async () => {
    const f = await make({ acl: READ_PUB });
    f.add({ tool: "bulk_create_notes", paths: ["pub/a.md", "secret/x.md"], omitted: 2 });
    const o = await data(f, { path: "pub/a.md", response_format: "detailed" });
    expect(o.records[0]?.paths?.map((p) => p.path)).toEqual(["pub/a.md"]);
    expect(o.records[0]).not.toHaveProperty("paths_truncated");
  });

  it("a record with nothing hidden still reports its truncation", async () => {
    const f = await make({ acl: READ_PUB });
    f.add({ tool: "bulk_create_notes", paths: ["pub/a.md"], omitted: 2 });
    const o = await data(f, { path: "pub/a.md", response_format: "detailed" });
    expect(o.records[0]?.paths_truncated).toBe(true);
  });
});

describe("RED 6: a cursor is one this server issued for this request", () => {
  const seed = async () => {
    const f = await make();
    for (let i = 0; i < 5; i++) f.add({ paths: ["a.md"] });
    return f;
  };

  it("an issued cursor pages without a gap or a duplicate", async () => {
    const f = await seed();
    const p1 = await data(f, { path: "a.md", limit: 2 });
    expect(seqs(p1)).toEqual([5, 4]);
    const p2 = await data(f, { path: "a.md", limit: 2, cursor: p1.next_cursor });
    expect(seqs(p2)).toEqual([3, 2]);
    const p3 = await data(f, { path: "a.md", limit: 2, cursor: p2.next_cursor });
    expect(seqs(p3)).toEqual([1]);
    expect(p3.next_cursor).toBeNull();
  });

  it("a hand-made numeric cursor is refused, in range or beyond the safe-integer range", async () => {
    const f = await seed();
    for (const cursor of ["3", "1", "9007199254740993", "9999999999999999"]) {
      const r = await f.get({ path: "a.md", cursor });
      expect(r.ok, cursor).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
    }
  });

  it("a cursor does not carry over to a different request", async () => {
    const f = await seed();
    const p1 = await data(f, { path: "a.md", limit: 2 });
    const other = await f.get({ path: "a.md", limit: 3, cursor: p1.next_cursor });
    expect(other.ok).toBe(false);
  });
});
