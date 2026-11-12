// toolFacade.triadHotPath reaches the HTTP transport from config: wireTransports hands it to
// startHttp, which passes it on to createHttpApp's per-request createMcpServer (http.ts).
import { join } from "node:path";
import { ServerConfigSchema } from "@the-40-thieves/reliquary-tc-shared";
import { afterAll, describe, expect, it, vi } from "vitest";
import { wireTransports } from "../src/runtime/transport-wiring";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const { startHttp } = vi.hoisted(() => ({
  startHttp: vi.fn(async () => ({ port: 1, close: async () => {} })),
}));
vi.mock("../src/transports/http", () => ({ startHttp }));

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});

async function bootHttp(triadHotPath: boolean): Promise<void> {
  const root = makeTempDir("tw-hot-path-");
  dirs.push(root);
  const config = ServerConfigSchema.parse({
    vaults: [{ id: "v1", path: root }],
    cacheDir: join(root, "cache"),
    toolFacade: { triadHotPath },
    transports: { stdio: false, http: { enabled: true, host: "127.0.0.1", port: 47998 } },
    observability: { prometheus: { enabled: false, bind: "127.0.0.1", port: 0 } },
  });
  const wiring = await wireTransports({
    config,
    version: "t",
    registry: {},
    db: openMemoryDb(),
    firstVaultId: "v1",
  } as unknown as Parameters<typeof wireTransports>[0]);
  await wiring.close();
}

describe("toolFacade.triadHotPath reaches the HTTP transport", () => {
  it("passes triadHotPath: true from config to startHttp", async () => {
    await bootHttp(true);
    expect(startHttp).toHaveBeenCalledWith(expect.objectContaining({ triadHotPath: true }));
  });
});
