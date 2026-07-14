// Opt-in LIVE smoke test for the companion <-> Local REST API bridge (THE-383, the CI gap
// #153 called out). Every OTHER bridge test runs against an in-process FAKE of Local REST
// API (bridge/fake.ts), so it cannot catch companion<->LRA integration bugs like the
// #152/#153/#154 cluster (wrong getPublicApi entry point, unprefixed routes, wrong plugin
// id) — those pass CI yet 404 in reality. Obsidian is a GUI Electron app that cannot boot
// headless in CI, so this suite is DISABLED by default and only runs when pointed at a real
// running Obsidian.
//
// It does NOT modify your vault (editing community-plugins.json under a running Obsidian
// races with Obsidian's own persistence). Install + enable the companion first, then run it:
//   1. cd packages/plugin && bun run build      (or: obsidian-tc plugin install --vault <path>)
//   2. copy packages/plugin/dist/{main.js,manifest.json,styles.css}
//        -> <vault>/.obsidian/plugins/obsidian-tc/
//   3. enable "obsidian-tc" in Obsidian (Settings -> Community plugins) and reload the app.
// Then, from packages/server:
//   OBSIDIAN_TC_LIVE=1 OBSIDIAN_TC_LIVE_VAULT="C:/path/to/your/vault" \
//   OBSIDIAN_TC_LIVE_EXPECT="dataview,text-extractor" \
//   node ./node_modules/vitest/vitest.mjs run test/live-companion.test.ts
//
// It asserts GET {prefix}/probe == 200 with a sane capability snapshot + a live command
// round-trip + LRA's native /commands/ route (the #155 fallback target). The companion
// registers on LRA's SECURE (https) server, so the test talks https and pins LRA's
// self-signed cert as a trusted CA (from the vault's LRA data.json, or a PEM at
// OBSIDIAN_TC_LIVE_CACERT) — it never disables TLS validation.
//
// Env: OBSIDIAN_TC_LIVE (gate) | OBSIDIAN_TC_LIVE_VAULT (vault path; its LRA data.json supplies
// the key + cert) | OBSIDIAN_TC_LIVE_URL (default https://127.0.0.1:27124) | OBSIDIAN_TC_LIVE_KEY
// | OBSIDIAN_TC_LIVE_CACERT (PEM path; default: the vault cert) | OBSIDIAN_TC_LIVE_PREFIX
// (default /obsidian-tc/v1) | OBSIDIAN_TC_LIVE_EXPECT (CSV of capability keys expected installed).
import { readFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const LIVE = !!process.env.OBSIDIAN_TC_LIVE;
const VAULT = process.env.OBSIDIAN_TC_LIVE_VAULT ?? "";
const BASE = (process.env.OBSIDIAN_TC_LIVE_URL ?? "https://127.0.0.1:27124").replace(/\/+$/, "");
const PREFIX = process.env.OBSIDIAN_TC_LIVE_PREFIX ?? "/obsidian-tc/v1";
const EXPECT = (process.env.OBSIDIAN_TC_LIVE_EXPECT ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const CAP_KEYS = [
  "excalidraw",
  "dataview",
  "tasks",
  "templater",
  "quickadd",
  "text-extractor",
  "make-md",
];

const lraDataJson = VAULT
  ? join(VAULT, ".obsidian", "plugins", "obsidian-local-rest-api", "data.json")
  : "";

function lraData(): { apiKey?: string; crypto?: { cert?: string } } {
  return JSON.parse(readFileSync(lraDataJson, "utf8")) as {
    apiKey?: string;
    crypto?: { cert?: string };
  };
}

function lraKey(): string {
  const key = process.env.OBSIDIAN_TC_LIVE_KEY ?? lraData().apiKey;
  if (!key) throw new Error("no LRA apiKey (set OBSIDIAN_TC_LIVE_KEY or OBSIDIAN_TC_LIVE_VAULT)");
  return key;
}

// LRA serves a self-signed cert on its https port; pin it as a trusted CA (we NEVER disable
// TLS validation). Memoized: one agent per run.
let agent: https.Agent | undefined;
function httpsAgent(): https.Agent {
  if (!agent) {
    const caPath = process.env.OBSIDIAN_TC_LIVE_CACERT;
    const ca = caPath ? readFileSync(caPath, "utf8") : lraData().crypto?.cert;
    if (!ca)
      throw new Error("no LRA cert to pin (set OBSIDIAN_TC_LIVE_CACERT or OBSIDIAN_TC_LIVE_VAULT)");
    agent = new https.Agent({ ca });
  }
  return agent;
}

function api(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; json: unknown }> {
  const url = new URL(`${BASE}${path}`);
  const secure = url.protocol === "https:";
  const lib = secure ? https : http;
  const body = init?.body !== undefined ? JSON.stringify(init.body) : undefined;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: init?.method ?? "GET",
        headers: {
          authorization: `Bearer ${lraKey()}`,
          ...(body !== undefined
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) }
            : {}),
        },
        ...(secure ? { agent: httpsAgent() } : {}),
      },
      (res) => {
        let d = "";
        res.on("data", (c) => {
          d += c;
        });
        res.on("end", () => {
          let json: unknown = null;
          try {
            json = d ? JSON.parse(d) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe.skipIf(!LIVE)("live companion <-> LRA bridge (opt-in)", () => {
  beforeAll(async () => {
    if (!VAULT) throw new Error("set OBSIDIAN_TC_LIVE_VAULT to the vault path");
    const { status } = await api(`${PREFIX}/probe`).catch(() => ({ status: 0, json: null }));
    if (status !== 200)
      throw new Error(
        `companion bridge not reachable at ${BASE}${PREFIX}/probe (got ${status}). Install + enable ` +
          "the obsidian-tc companion in this vault and reload Obsidian first (see the file header).",
      );
  }, 15_000);

  it("GET {prefix}/probe returns 200 with a sane capability snapshot (#153/#154)", async () => {
    const { status, json } = await api(`${PREFIX}/probe`);
    expect(status).toBe(200);
    const env = json as { ok?: boolean; result?: Record<string, unknown> };
    expect(env.ok).toBe(true);
    const r = env.result ?? {};
    expect(r.obsidianTcApiVersion).toBe("1");
    expect(r.shape_ok).toBe(true);
    const caps = (r.capabilities ?? {}) as Record<string, { installed?: boolean }>;
    for (const k of CAP_KEYS) expect(caps, `capability ${k} missing from probe`).toHaveProperty(k);
  });

  it.skipIf(EXPECT.length === 0)(
    "declared plugins report installed:true (catches the #152 wrong-id bug)",
    async () => {
      const { json } = await api(`${PREFIX}/probe`);
      const caps =
        (json as { result?: { capabilities?: Record<string, { installed?: boolean }> } }).result
          ?.capabilities ?? {};
      for (const k of EXPECT) expect(caps[k]?.installed, `${k} should be installed`).toBe(true);
    },
  );

  it("POST {prefix}/commands/list returns the live command palette", async () => {
    const { status, json } = await api(`${PREFIX}/commands/list`, { method: "POST", body: {} });
    expect(status).toBe(200);
    const r = json as { ok?: boolean; result?: { items?: unknown[]; total?: number } };
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.result?.items)).toBe(true);
    expect(r.result?.total ?? 0).toBeGreaterThan(0);
  });

  it("LRA's native GET /commands/ answers 200 (the #155 fallback target)", async () => {
    const { status, json } = await api("/commands/");
    expect(status).toBe(200);
    expect(Array.isArray((json as { commands?: unknown[] }).commands)).toBe(true);
  });
});
