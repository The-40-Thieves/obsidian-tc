// Retention for the write-provenance chain. Pruning is the one sanctioned way to remove records, so
// the invariant is: after a prune the chain still verifies, and any OTHER removal still does not.
import { describe, expect, it } from "vitest";
import { runMaintenanceSweep } from "../src/db/maintenance";
import { registrySignerSource } from "../src/provenance/signer";
import { appendProvenance, pruneProvenance } from "../src/provenance/store";
import { verifyProvenance } from "../src/provenance/verify";
import { sweepTotal } from "../src/runtime/maintenance-wiring";
import { CLOCK0, provenanceFixture, rowsFor } from "./provenance-helpers";

type Fx = Awaited<ReturnType<typeof provenanceFixture>>;

const DAY = 86_400_000;
const VAULT = "v1";

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("expected a value");
  return v;
}

/** `n` records, record i stamped `ageDays(i)` days before CLOCK0. */
function seed(fx: Fx, n: number, ageDays: (i: number) => number, vault = VAULT): void {
  const signer = registrySignerSource(fx.registry)();
  for (let i = 1; i <= n; i++) {
    appendProvenance(
      fx.db,
      {
        vaultId: vault,
        ts: CLOCK0 - ageDays(i) * DAY,
        tool: `tool_${i}`,
        outcome: "ok",
        paths: [],
        pathsOmitted: 0,
        verified: { host: "h", server_version: "0" },
        unauthenticated: {},
        self_reported: {},
      },
      signer,
    );
  }
}

const verify = (fx: Fx, vault = VAULT) =>
  must(verifyProvenance(fx.db, { resolveKey: fx.resolveKey(), allowUnsigned: false }, vault)[0]);

describe("provenance retention", () => {
  it("prune of the oldest records keeps the chain verifying via the signed anchor", async () => {
    const fx = await provenanceFixture();
    seed(fx, 6, (i) => 10 - i); // ages 9..4 days, oldest first
    const removed = pruneProvenance(
      fx.db,
      VAULT,
      CLOCK0 - 7 * DAY,
      registrySignerSource(fx.registry)(),
    );
    expect(removed).toBe(2); // ages 9 and 8; the record exactly at the cutoff is kept
    const r = verify(fx);
    expect(r).toMatchObject({ ok: true, problems: [] });
    expect(r.records).toBe(6 - removed);
  });

  it("a second prune and further appends still verify", async () => {
    const fx = await provenanceFixture();
    seed(fx, 4, (i) => 10 - i);
    pruneProvenance(fx.db, VAULT, CLOCK0 - 8 * DAY, registrySignerSource(fx.registry)());
    seed(fx, 2, () => 0);
    pruneProvenance(fx.db, VAULT, CLOCK0 - 6 * DAY, registrySignerSource(fx.registry)());
    expect(verify(fx)).toMatchObject({ ok: true, problems: [] });
  });

  it("pruning everything leaves an empty chain that verifies and keeps the head", async () => {
    const fx = await provenanceFixture();
    seed(fx, 3, () => 30);
    expect(pruneProvenance(fx.db, VAULT, CLOCK0 - DAY, registrySignerSource(fx.registry)())).toBe(
      3,
    );
    expect(rowsFor(fx.db)).toHaveLength(0);
    expect(verify(fx)).toMatchObject({ ok: true, records: 0 });
    seed(fx, 1, () => 0);
    expect(verify(fx)).toMatchObject({ ok: true, records: 1 });
  });

  it("RED: a prune that drops a non-oldest record fails verify", async () => {
    const fx = await provenanceFixture();
    seed(fx, 6, (i) => 10 - i);
    pruneProvenance(fx.db, VAULT, CLOCK0 - 8 * DAY, registrySignerSource(fx.registry)());
    // The honest prune took seq 1 only. A second, hand-made deletion in the middle is not a prune.
    const keep = must(rowsFor(fx.db)[2]);
    fx.db.prepare("DELETE FROM write_provenance WHERE seq = ?").run(keep.seq);
    const r = verify(fx);
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => p.code)).toEqual(expect.arrayContaining(["seq_gap"]));
  });

  it("RED: dropping a prefix WITHOUT moving the signed anchor fails verify", async () => {
    const fx = await provenanceFixture();
    seed(fx, 5, (i) => 10 - i);
    fx.db.prepare("DELETE FROM write_provenance WHERE seq <= 2").run();
    const r = verify(fx);
    expect(r.ok).toBe(false);
  });

  it("RED: a prefix dropped under a forged anchor fails verify (the anchor is signed)", async () => {
    const fx = await provenanceFixture();
    seed(fx, 5, (i) => 10 - i);
    const second = must(rowsFor(fx.db)[1]);
    fx.db.prepare("DELETE FROM write_provenance WHERE seq <= 2").run();
    fx.db
      .prepare(
        "UPDATE write_provenance_heads SET pruned_seq = 2, pruned_hash = ? WHERE vault_id = ?",
      )
      .run(second.hash, VAULT);
    const r = verify(fx);
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => p.code)).toContain("head_bad_signature");
  });

  it("refuses to pump an unsigned head over a signed one (no silent downgrade)", async () => {
    const fx = await provenanceFixture();
    seed(fx, 4, (i) => 10 - i);
    expect(pruneProvenance(fx.db, VAULT, CLOCK0 - 8 * DAY, undefined)).toBe(0);
    expect(verify(fx)).toMatchObject({ ok: true, records: 4 });
  });

  it("only the named vault is pruned", async () => {
    const fx = await provenanceFixture();
    seed(fx, 3, () => 30, "a");
    seed(fx, 3, () => 30, "b");
    pruneProvenance(fx.db, "a", CLOCK0 - DAY, registrySignerSource(fx.registry)());
    expect(verify(fx, "a")).toMatchObject({ ok: true, records: 0 });
    expect(verify(fx, "b")).toMatchObject({ ok: true, records: 3 });
  });
});

describe("provenance retention in the maintenance sweep", () => {
  const sweepOpts = (extra: Record<string, unknown> = {}) => ({
    now: () => CLOCK0,
    eventLogDays: 30,
    jobsCompleteDays: 30,
    jobsFailedDays: 30,
    ...extra,
  });

  it("prunes every vault past retention, counts the rows, and the chains still verify", async () => {
    const fx = await provenanceFixture();
    seed(fx, 4, (i) => 20 - i, "a"); // ages 19..16
    seed(fx, 3, (i) => 5 - i, "b"); // ages 4..2
    const counts = runMaintenanceSweep(
      fx.db,
      sweepOpts({
        provenanceRetention: { days: 10, signer: registrySignerSource(fx.registry) },
      }),
    );
    expect(counts.provenance).toBe(4);
    expect(sweepTotal(counts)).toBeGreaterThanOrEqual(4);
    expect(verify(fx, "a")).toMatchObject({ ok: true, records: 0 });
    expect(verify(fx, "b")).toMatchObject({ ok: true, records: 3 });
  });

  it("absent retention keeps everything forever", async () => {
    const fx = await provenanceFixture();
    seed(fx, 3, () => 3650);
    const counts = runMaintenanceSweep(fx.db, sweepOpts());
    expect(counts.provenance).toBe(0);
    expect(rowsFor(fx.db)).toHaveLength(3);
  });

  it("a throwing prune is reported and does not take the sweep down", async () => {
    const fx = await provenanceFixture();
    seed(fx, 3, () => 30);
    const counts = runMaintenanceSweep(
      fx.db,
      sweepOpts({
        provenanceRetention: {
          days: 1,
          signer: () => {
            throw new Error("registry offline");
          },
        },
      }),
    );
    expect(counts.provenance).toBe(0);
    expect(rowsFor(fx.db)).toHaveLength(3);
  });
});
