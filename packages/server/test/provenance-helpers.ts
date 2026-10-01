// Shared fixture for the write-provenance tests: a cache.db, a real auth registry (own temp
// keys dir, own auth.db) holding an EdDSA signing key, and a recorder wired to sign with it.
import { authKeysDir, createAuthRegistry } from "../src/auth/registry";
import { generateSigningKey } from "../src/auth/signing-keys";
import { provisionAuthDb, provisionCacheDb } from "../src/db/provision";
import { ProvenanceRecorder } from "../src/provenance/recorder";
import { registryKeyResolver, registrySignerSource } from "../src/provenance/signer";
import { openMemoryDb } from "./helpers";
import { makeTempDir } from "./tmp";

export const CLOCK0 = 1_800_000_000_000;

export async function provenanceFixture(opts: { signed?: boolean } = {}) {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const authDb = openMemoryDb();
  provisionAuthDb(authDb);
  const dir = makeTempDir("obtc-prov-");
  const registry = createAuthRegistry(authDb, { keysDir: authKeysDir(dir) });
  const clock = { t: CLOCK0 };
  const rotate = async (graceSeconds = 3600) =>
    registry.rotateKey({
      alg: "EdDSA",
      graceSeconds,
      generated: await generateSigningKey("EdDSA"),
    });
  if (opts.signed !== false) await rotate();
  const recorder = new ProvenanceRecorder({
    db,
    host: "host-test",
    serverVersion: "0.0.0-test",
    signer: registrySignerSource(registry),
    now: () => ++clock.t,
    onError: (tool, _vault, e) => {
      throw new Error(`provenance fault in ${tool}: ${String(e)}`);
    },
  });
  return {
    db,
    dir,
    registry,
    recorder,
    clock,
    rotate,
    resolveKey: () => registryKeyResolver(registry.listKeys()),
  };
}

export const rowsFor = (db: { prepare(sql: string): { all(...p: unknown[]): unknown[] } }) =>
  db.prepare("SELECT * FROM write_provenance ORDER BY vault_id, seq").all() as Array<{
    vault_id: string;
    seq: number;
    ts: number;
    body: string;
    prev_hash: string;
    hash: string;
    kid: string | null;
    sig: string | null;
  }>;
