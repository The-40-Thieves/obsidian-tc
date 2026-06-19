// search_dql / search_vault(mode:dql) rewired onto the Dataview bridge (THE-180).
// Proves the dedicated tool proxies to /dataview/dql, degrades when the bridge is
// unreachable or unconfigured, and that the router's dql mode enforces read:dataview
// inline (deny-by-default). Self-contained inline harness — the M2 search harness
// stays bridge-free, so the existing "plugin_missing (no bridge)" test is unchanged.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  type FakeRequestInfo,
  type FakeRoute,
  createBridgeClient,
  fakeBridgeTransport,
} from "../src/bridge";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { ToolRegistry } from "../src/mcp/registry";
import type { M2Deps } from "../src/tools/m2";
import { buildSearchTools } from "../src/tools/m2/search-tools";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";

const schemaSql = readFileSync(
  fileURLToPath(new URL("../src/schema.sql", import.meta.url)),
  "utf8",
);

interface Rig {
  call: (
    name: string,
    input: Record<string, unknown>,
    scopes?: string[],
  ) => ReturnType<ToolRegistry["dispatch"]>;
  requests: FakeRequestInfo[];
  cleanup: () => void;
}

function makeRig(opts: {
  routes?: Record<string, FakeRoute>;
  unreachable?: boolean;
  noBridge?: boolean;
}): Rig {
  const root = mkdtempSync(join(tmpdir(), "obtc-dql-"));
  const db = openMemoryDb();
  db.exec(schemaSql);
  const vaultRegistry = new VaultRegistry([{ id: "test", path: root }]);
  const requests: FakeRequestInfo[] = [];
  const client = createBridgeClient({
    baseUrl: "http://127.0.0.1:27124",
    apiKey: "test-key",
    fetchFn: fakeBridgeTransport({ routes: opts.routes ?? {}, onRequest: (i) => requests.push(i) }),
  });

  let dataviewBridge: M2Deps["dataviewBridge"];
  if (opts.noBridge) dataviewBridge = undefined;
  else if (opts.unreachable)
    dataviewBridge = () => {
      throw err.pluginUnreachable("companion did not answer", { plugin: "dataview" });
    };
  else dataviewBridge = () => ({ client, timeoutMs: 5000 });

  const registry = new ToolRegistry();
  for (const tool of buildSearchTools({
    vaultRegistry,
    embeddingProvider: fakeEmbeddingProvider({ dimensions: 8 }),
    dataviewBridge,
  }))
    registry.register(tool);

  return {
    call: (name, input, scopes = ["*"]) =>
      registry.dispatch(name, input, {
        caller: "t",
        authenticated: true,
        grantedScopes: new Set(scopes),
        vaultId: "test",
        db,
      }),
    requests,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const DQL_OK: Record<string, FakeRoute> = {
  "POST /obsidian-tc/v1/dataview/dql": {
    body: { ok: true, result: { headers: ["File"], rows: [["A.md"]], note_paths: ["A.md"] } },
  },
};

describe("search_dql via the Dataview bridge", () => {
  let rig: Rig | undefined;
  afterEach(() => rig?.cleanup());

  it("proxies to /dataview/dql and returns headers/rows/note_paths", async () => {
    rig = makeRig({ routes: DQL_OK });
    const res = await rig.call("search_dql", { vault: "test", dql: "TABLE file.name" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as Record<string, unknown>;
      expect(data.vault).toBe("test");
      expect(data.rows).toEqual([["A.md"]]);
      expect(data.note_paths).toEqual(["A.md"]);
    }
    const req = rig.requests[0];
    if (!req) throw new Error("expected a bridge request");
    const body = JSON.parse(req.body ?? "{}") as Record<string, unknown>;
    expect(body.dql).toBe("TABLE file.name");
    expect(body.format).toBe("table");
  });

  it("degrades to plugin_unreachable when the bridge does not answer", async () => {
    rig = makeRig({ unreachable: true });
    const res = await rig.call("search_dql", { vault: "test", dql: "LIST" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("plugin_unreachable");
  });

  it("reports plugin_missing when no Dataview bridge is configured", async () => {
    rig = makeRig({ noBridge: true });
    const res = await rig.call("search_dql", { vault: "test", dql: "LIST" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("plugin_missing");
  });
});

describe("search_vault mode:dql", () => {
  let rig: Rig | undefined;
  afterEach(() => rig?.cleanup());

  it("denies the dql mode to a caller lacking read:dataview", async () => {
    rig = makeRig({ routes: DQL_OK });
    const res = await rig.call(
      "search_vault",
      { vault: "test", query: "TABLE file.name", mode: "dql" },
      ["read:notes"],
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("forbidden");
    // Scope is denied at the handler before any bridge call.
    expect(rig.requests).toHaveLength(0);
  });

  it("routes the dql mode through the bridge with read:dataview", async () => {
    rig = makeRig({ routes: DQL_OK });
    const res = await rig.call(
      "search_vault",
      { vault: "test", query: "TABLE file.name", mode: "dql" },
      ["read:notes", "read:dataview"],
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as Record<string, unknown>;
      expect(data.mode_used).toBe("dql");
      expect(data.note_paths).toEqual(["A.md"]);
    }
  });
});
