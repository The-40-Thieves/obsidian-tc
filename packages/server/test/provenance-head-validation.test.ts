// The signed head is only worth something if every writer of it checks it first. These cases are the
// laundering paths a writer of cache.db WITHOUT the signing key can try: plant a prune anchor or
// rewind the tail (the head signature then no longer verifies), wait for the next legitimate write,
// and hope the server re-signs the planted head. The server must refuse to, keep the evidence, and
// still record the write in a form `verify` flags.
import { describe, expect, it } from "vitest";
import { pruneProvenance } from "../src/provenance/retention";
import { registrySignerSource } from "../src/provenance/signer";
import { appendProvenance, readHeadRow } from "../src/provenance/store";
import { verifyProvenance } from "../src/provenance/verify";
import { CLOCK0, provenanceFixture, rowsFor } from "./provenance-helpers";

type Fx = Awaited<ReturnType<typeof provenanceFixture>>;
const DAY = 86_400_000;
const VAULT = "main";

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("expected a value");
  return v;
}

/** One `write_note`-shaped record, signed with the fixture's key unless `signed` is false (an outage). */
function write(fx: Fx, ts = CLOCK0, signed = true) {
  return appendProvenance(
    fx.db,
    {
      vaultId: VAULT,
      ts,
      tool: "write_note",
      outcome: "ok",
      paths: [{ path: "a.md", before: "absent", after: "f".repeat(64) }],
      pathsOmitted: 0,
      verified: { host: "h", server_version: "0" },
      unauthenticated: {},
      self_reported: {},
    },
    signed ? registrySignerSource(fx.registry)() : undefined,
  );
}

const verify = (fx: Fx, allowUnsigned = false) =>
  must(verifyProvenance(fx.db, { resolveKey: fx.resolveKey(), allowUnsigned }, VAULT)[0]);
const codes = (fx: Fx, allowUnsigned = false) =>
  verify(fx, allowUnsigned).problems.map((p) => p.code);

describe("head validation before append", () => {
  it("(a) a planted prune anchor is NOT re-signed by the next write: verify fails", async () => {
    const fx = await provenanceFixture();
    for (let i = 0; i < 3; i++) write(fx);
    const h2 = must(rowsFor(fx.db)[1]).hash;
    fx.db.prepare("DELETE FROM write_provenance WHERE vault_id = ? AND seq <= 2").run(VAULT);
    fx.db
      .prepare(
        "UPDATE write_provenance_heads SET pruned_seq = 2, pruned_hash = ? WHERE vault_id = ?",
      )
      .run(h2, VAULT);
    const badHead = { ...must(readHeadRow(fx.db, VAULT)) };
    write(fx);
    expect(verify(fx).ok).toBe(false);
    expect(codes(fx)).toContain("head_bad_signature");
    // The evidence is kept: the forged head row was not overwritten, and a record states why.
    expect(readHeadRow(fx.db, VAULT)).toEqual(badHead);
    expect(codes(fx)).toContain("head_untrusted");
  });

  it("(b) a rewound tail is NOT re-signed by the next write: verify fails", async () => {
    const fx = await provenanceFixture();
    for (let i = 0; i < 3; i++) write(fx);
    const h2 = must(rowsFor(fx.db)[1]).hash;
    fx.db.prepare("DELETE FROM write_provenance WHERE vault_id = ? AND seq = 3").run(VAULT);
    fx.db
      .prepare("UPDATE write_provenance_heads SET head_seq = 2, head_hash = ? WHERE vault_id = ?")
      .run(h2, VAULT);
    write(fx);
    expect(verify(fx).ok).toBe(false);
    expect(codes(fx)).toEqual(expect.arrayContaining(["head_bad_signature", "head_untrusted"]));
  });

  it("(b2) a removed tail with the head left as signed is also refused", async () => {
    const fx = await provenanceFixture();
    for (let i = 0; i < 3; i++) write(fx);
    fx.db.prepare("DELETE FROM write_provenance WHERE vault_id = ? AND seq = 3").run(VAULT);
    const head = { ...must(readHeadRow(fx.db, VAULT)) };
    write(fx);
    expect(readHeadRow(fx.db, VAULT)).toEqual(head);
    expect(verify(fx).ok).toBe(false);
    expect(codes(fx)).toContain("head_untrusted");
  });

  it("a deleted head row over surviving records is not re-created and signed", async () => {
    const fx = await provenanceFixture();
    for (let i = 0; i < 3; i++) write(fx);
    fx.db.prepare("DELETE FROM write_provenance WHERE vault_id = ? AND seq = 3").run(VAULT);
    fx.db.prepare("DELETE FROM write_provenance_heads").run();
    write(fx);
    expect(readHeadRow(fx.db, VAULT)).toBeUndefined();
    expect(codes(fx)).toEqual(expect.arrayContaining(["head_missing", "head_untrusted"]));
  });

  it("a head whose signature was stripped is not re-signed", async () => {
    const fx = await provenanceFixture();
    for (let i = 0; i < 2; i++) write(fx);
    fx.db.prepare("UPDATE write_provenance_heads SET kid = NULL, sig = NULL").run();
    write(fx);
    expect(readHeadRow(fx.db, VAULT)?.sig).toBeNull();
    // Not hidden by --allow-unsigned: the marker on the record is not an "unsigned" problem.
    expect(verify(fx, true).ok).toBe(false);
    expect(codes(fx, true)).toContain("head_untrusted");
  });

  it("a prune also refuses a head that fails validation, and changes nothing", async () => {
    const fx = await provenanceFixture();
    for (let i = 0; i < 4; i++) write(fx, CLOCK0 - (10 - i) * DAY);
    fx.db.prepare("DELETE FROM write_provenance WHERE vault_id = ? AND seq = 4").run(VAULT);
    const before = rowsFor(fx.db).length;
    const head = { ...must(readHeadRow(fx.db, VAULT)) };
    const removed = pruneProvenance(
      fx.db,
      VAULT,
      CLOCK0 - 8 * DAY,
      registrySignerSource(fx.registry)(),
    );
    expect(removed).toBe(0);
    expect(rowsFor(fx.db)).toHaveLength(before);
    expect(readHeadRow(fx.db, VAULT)).toEqual(head);
  });

  it("(c) a signer outage after a signed head does not downgrade the head", async () => {
    const fx = await provenanceFixture();
    write(fx);
    write(fx);
    const head = { ...must(readHeadRow(fx.db, VAULT)) };
    expect(() => write(fx, CLOCK0, false)).toThrow(/signer/i);
    expect(readHeadRow(fx.db, VAULT)).toEqual(head);
    expect(rowsFor(fx.db)).toHaveLength(2);
    expect(verify(fx)).toMatchObject({ ok: true, problems: [] });
    // And the chain carries on once the signer is back.
    write(fx);
    expect(verify(fx)).toMatchObject({ ok: true, records: 3, problems: [] });
  });

  it("(d) a legitimate retention prune followed by a write verifies", async () => {
    const fx = await provenanceFixture();
    for (let i = 0; i < 5; i++) write(fx, CLOCK0 - (10 - i) * DAY);
    expect(
      pruneProvenance(fx.db, VAULT, CLOCK0 - 7 * DAY, registrySignerSource(fx.registry)()),
    ).toBe(3);
    write(fx);
    write(fx);
    expect(verify(fx)).toMatchObject({ ok: true, records: 4, problems: [] });
  });

  it("a never-signed deployment keeps appending unsigned, and an unsigned era upgrades cleanly", async () => {
    const fx = await provenanceFixture();
    write(fx, CLOCK0, false);
    write(fx, CLOCK0, false);
    expect(verify(fx, true).ok).toBe(true);
    write(fx); // a signing key shows up
    expect(readHeadRow(fx.db, VAULT)?.sig).not.toBeNull();
    expect(codes(fx, true).filter((c) => c !== "unsigned")).toEqual([]);
  });
});
