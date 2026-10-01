// The MCP HTTP edge and /metrics are handed the SAME bearer-verifier instance, built once at boot
// from the whole auth config. /metrics used to build its own from `jwtSecret` + registry only, so
// it dropped auth.jwks / jwksFile / jwksUri and refused tokens the MCP edge accepted.
import { join } from "node:path";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { exportJWK, generateKeyPair } from "jose";
import { afterAll, expect, it, vi } from "vitest";
import { MetricsRecorder } from "../src/metrics/registry";
import { wireTransports } from "../src/runtime/transport-wiring";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const seen = vi.hoisted(() => ({ http: undefined as unknown, metrics: undefined as unknown }));
vi.mock("../src/transports/http", () => ({
  startHttp: async (o: { verifier?: unknown }) => {
    seen.http = o.verifier;
    return { port: 1, close: async () => {} };
  },
}));
vi.mock("../src/metrics/endpoint", () => ({
  startMetricsEndpoint: async (o: { verifier?: unknown }) => {
    seen.metrics = o.verifier;
    return { port: 2, close: async () => {} };
  },
}));

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});

it("wireTransports injects one jwt verifier, built with the JWKS, into both listeners", async () => {
  const root = makeTempDir("tw-one-verifier-");
  dirs.push(root);
  const { publicKey } = await generateKeyPair("RS256");
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" }] };
  const config = ServerConfigSchema.parse({
    vaults: [{ id: "v1", path: root }],
    cacheDir: join(root, "cache"),
    auth: { mode: "jwt", jwks, audience: "https://obsidian-tc.example" },
    transports: { stdio: false, http: { enabled: true, host: "127.0.0.1", port: 47998 } },
    observability: { prometheus: { enabled: true, bind: "127.0.0.1", port: 0 } },
  });
  const wiring = await wireTransports({
    config,
    version: "t",
    registry: {},
    vaultRegistry: {},
    db: openMemoryDb(),
    firstVaultId: "v1",
    acl: {},
    jobQueue: {},
    metrics: new MetricsRecorder(),
  } as unknown as Parameters<typeof wireTransports>[0]);
  try {
    expect(seen.http).toBeDefined();
    expect(seen.metrics).toBe(seen.http);
  } finally {
    await wiring.close();
  }
});
