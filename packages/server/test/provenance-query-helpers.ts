// Fixture for the get_provenance tests: a real test vault (its cache.db), a real auth registry
// holding an EdDSA key, and `add` to append genuine signed records the way the recorder does.
import { registrySignerSource } from "../src/provenance/signer";
import { appendProvenance } from "../src/provenance/store";
import type { PathEntry, ProvenanceBody } from "../src/provenance/types";
import type { TestVaultOptions } from "./m1-helpers";
import { makeTestVault } from "./m1-helpers";
import { CLOCK0, provenanceFixture } from "./provenance-helpers";
import { rmTemp } from "./tmp";

export const h = (c: string): string => c.padEnd(64, "0").slice(0, 64);

export interface SeedRecord {
  tool?: string;
  vault?: string;
  paths: Array<string | PathEntry>;
  outcome?: "ok" | "error";
  ts?: number;
  verified?: Partial<ProvenanceBody["verified"]>;
  unauthenticated?: ProvenanceBody["unauthenticated"];
  self_reported?: ProvenanceBody["self_reported"];
  omitted?: number;
}

export async function queryFixture(opts: TestVaultOptions & { signed?: boolean } = {}) {
  const fx = await provenanceFixture(opts.signed === undefined ? {} : { signed: opts.signed });
  const tv = makeTestVault({ provenanceKeys: () => fx.resolveKey(), ...opts });
  let n = 0;
  const add = (r: SeedRecord): number => {
    n++;
    const signer = registrySignerSource(fx.registry)();
    return appendProvenance(
      tv.db,
      {
        vaultId: r.vault ?? tv.id,
        ts: r.ts ?? CLOCK0 + n,
        tool: r.tool ?? "write_note",
        outcome: r.outcome ?? "ok",
        paths: r.paths.map((p) =>
          typeof p === "string" ? { path: p, before: h("aa"), after: h(`b${n}`) } : p,
        ),
        pathsOmitted: r.omitted ?? 0,
        verified: { host: "host-1", server_version: "1.0.0", ...r.verified },
        unauthenticated: r.unauthenticated ?? {},
        self_reported: r.self_reported ?? {},
      },
      opts.signed === false ? undefined : signer,
    ).seq;
  };
  const get = (input: Record<string, unknown>, over = {}) =>
    tv.call("get_provenance", { vault: tv.id, ...input }, over);
  const cleanup = () => {
    tv.cleanup();
    rmTemp(fx.dir);
  };
  return { fx, tv, add, get, cleanup };
}

/** A move record as move_note writes it: `[from, to]`, from gone, to now holding the bytes. */
export const moved = (from: string, to: string, hash = h("cc")): PathEntry[] => [
  { path: from, before: hash, after: "absent" },
  { path: to, before: "absent", after: hash },
];
