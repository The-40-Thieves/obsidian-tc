// provenance.chain doctor check: any sign the evidence was altered is a FAIL; unsigned records are a
// warning that names the fix; a fresh install (no records, no EdDSA key) is ok with a note. Also
// drives the whole path from real rows: a chain verified by `inspectProvenance` feeds the view.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveServeConfig } from "../src/cli/resolve-config";
import { openConfiguredDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import { type ProvenanceView, provenanceCheck } from "../src/doctor/provenance";
import { inspectProvenance } from "../src/provenance/inspect";
import { appendProvenance } from "../src/provenance/store";
import { makeTempDir, rmTemp } from "./tmp";

const ctx = { serverVersion: "test" };
const base: ProvenanceView = {
  enabled: true,
  registryState: "ok",
  signingKeyActive: true,
  vaults: [{ vault: "main", records: 3, signed: 3, unsigned: 0, problems: [] }],
};
const run = (over: Partial<ProvenanceView>) => provenanceCheck({ ...base, ...over }).run(ctx);

describe("provenance.chain doctor check", () => {
  it("is ok with a verified, signed chain", async () => {
    const r = await run({});
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("3 records verified");
  });

  it("FAILS on a removed last record, naming the head", async () => {
    const r = await run({
      vaults: [
        {
          vault: "main",
          records: 2,
          signed: 2,
          unsigned: 0,
          problems: [{ code: "head_mismatch", detail: "a record was removed from the end" }],
        },
      ],
    });
    expect(r.status).toBe("fail");
    expect(r.issues?.[0]).toContain("head_mismatch");
    expect(r.remediation).toContain("provenance verify");
  });

  it("FAILS on a tampered record even when other records are merely unsigned", async () => {
    const r = await run({
      vaults: [
        {
          vault: "main",
          records: 2,
          signed: 0,
          unsigned: 2,
          problems: [
            { code: "unsigned", seq: 1, detail: "no signature" },
            { code: "hash_mismatch", seq: 2, detail: "changed" },
          ],
        },
      ],
    });
    expect(r.status).toBe("fail");
  });

  it("warns, naming the EdDSA fix, when records are unsigned", async () => {
    const r = await run({
      signingKeyActive: false,
      vaults: [
        {
          vault: "main",
          records: 2,
          signed: 0,
          unsigned: 2,
          problems: [{ code: "unsigned", seq: 1, detail: "no signature" }],
        },
      ],
    });
    expect(r.status).toBe("warning");
    expect(r.remediation).toContain("--alg EdDSA");
  });

  it("a fresh install with no records and no EdDSA key is ok, with a note", async () => {
    const r = await run({ signingKeyActive: false, vaults: [] });
    expect(r.status).toBe("ok");
    expect(r.notes?.[0]).toContain("unsigned");
  });

  it("disabled with no chain is ok and says so", async () => {
    const r = await run({ enabled: false, signingKeyActive: false, vaults: [] });
    expect(r).toMatchObject({ status: "ok" });
    expect(r.summary).toContain("disabled");
  });

  it("warns, not passes, when the chain could not be read or the registry is lost", async () => {
    expect((await run({ unreadable: "no such table" })).status).toBe("warning");
    expect((await run({ registryState: "lost", registryDetail: "auth.db gone" })).status).toBe(
      "warning",
    );
  });
});

describe("inspectProvenance (the view's source)", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs.splice(0)) rmTemp(d);
  });

  it("finds an unsigned chain in a real cache.db and tampering shows up as failing", async () => {
    const root = makeTempDir("doc-prov-");
    dirs.push(root);
    const vault = join(root, "vault");
    mkdirSync(vault);
    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ vaults: [{ id: "main", path: vault }], cacheDir: join(root, "cache") }),
    );
    const cfg = resolveServeConfig(configPath);
    mkdirSync(cfg.cacheDir, { recursive: true });
    const db = await openConfiguredDatabase(cfg, "cache.db");
    provisionCacheDb(db);
    for (let i = 1; i <= 2; i++) {
      appendProvenance(
        db,
        {
          vaultId: "main",
          ts: i,
          tool: "write_note",
          outcome: "ok",
          paths: [],
          pathsOmitted: 0,
          verified: { host: "h", server_version: "0" },
          unauthenticated: {},
          self_reported: {},
        },
        undefined,
      );
    }
    db.close?.();
    const strict = await inspectProvenance(cfg);
    expect(strict).toMatchObject({ tablePresent: true, ok: false, signingKeyActive: false });
    expect(strict.vaults[0]).toMatchObject({ records: 2, unsigned: 2 });
    const lax = await inspectProvenance(cfg, { allowUnsigned: true });
    expect(lax.ok).toBe(true);
    const view: ProvenanceView = {
      enabled: true,
      registryState: strict.registry.state,
      signingKeyActive: strict.signingKeyActive,
      vaults: strict.vaults,
    };
    expect((await provenanceCheck(view).run(ctx)).status).toBe("warning");
  });
});
