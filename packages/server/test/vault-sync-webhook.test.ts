import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { loadGitSyncConfig } from "../src/git-sync/env";
import { ToolRegistry } from "../src/mcp/registry";
import { createHttpApp, type HttpApp } from "../src/transports/http";
import { vaultSyncWebhookFromEnv } from "../src/transports/vault-sync-webhook";
import { openMemoryDb } from "./helpers";
import { makeTempDir } from "./tmp";

const SECRET = "vault-sync-test-secret-0123456789abcdef";
const TOKEN_OK = "vault-sync-gitlab-token-0123456789abcdef";
const URL = "http://127.0.0.1:8765/hooks/vault-sync";
const HOST = { host: "127.0.0.1:8765" };
const BODY = '{"ref":"refs/heads/main"}';
const ONE_MIB = 1_048_576;

const handles: HttpApp[] = [];
const roots: string[] = [];
const cacheDirs = new Map<HttpApp, string>();

afterEach(async () => {
  vi.restoreAllMocks();
  for (const handle of handles.splice(0)) await handle.close();
});

function tempCache(): string {
  const root = makeTempDir("obtc-vault-sync-webhook-");
  roots.push(root);
  return join(root, "cache");
}

function app(
  options: {
    secret?: string | undefined;
    cacheDir?: string;
    enableDnsRebindingProtection?: boolean;
    allowedHosts?: string[];
  } = {},
): HttpApp {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const auth = ServerConfigSchema.parse({
    vaults: [{ id: "v1", path: "/tmp/v1" }],
    auth: { mode: "jwt", jwtSecret: "test-only-secret-not-a-real-credential-0123456789" },
  }).auth;
  const cacheDir = options.cacheDir ?? tempCache();
  const vaultSyncWebhook =
    options.secret === undefined
      ? undefined
      : vaultSyncWebhookFromEnv({ OBSIDIAN_TC_VAULT_GIT_WEBHOOK_SECRET: options.secret }, cacheDir);
  const handle = createHttpApp({
    name: "obsidian-tc",
    version: "0.0.0-test",
    registry: new ToolRegistry(),
    auth,
    db,
    vaultId: "v1",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    cacheDir,
    ...(vaultSyncWebhook ? { vaultSyncWebhook } : {}),
    ...(options.enableDnsRebindingProtection === undefined
      ? {}
      : { enableDnsRebindingProtection: options.enableDnsRebindingProtection }),
    ...(options.allowedHosts ? { allowedHosts: options.allowedHosts } : {}),
  });
  handles.push(handle);
  cacheDirs.set(handle, cacheDir);
  return handle;
}

function triggerPathOf(handle: HttpApp): string {
  return join(cacheDirs.get(handle) ?? "", "git-sync", "trigger");
}

function sign(body: string | Uint8Array, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function post(
  handle: HttpApp,
  headers: Record<string, string>,
  body: string | Uint8Array = BODY,
): Promise<Response> {
  return Promise.resolve(
    handle.app.request(URL, { method: "POST", headers: { ...HOST, ...headers }, body }),
  );
}

/** Everything a caller can observe about a response, so failures can be compared byte for byte. */
async function observable(response: Response) {
  return {
    status: response.status,
    body: await response.text(),
    cacheControl: response.headers.get("cache-control"),
  };
}

describe("vault-sync webhook: mounting and configuration", () => {
  it("is not routed at all when the secret is unset, and creates nothing", async () => {
    const cacheDir = tempCache();
    const handle = app({ cacheDir });

    const response = await post(handle, { "x-hub-signature-256": sign(BODY) });

    expect(response.status).toBe(404);
    expect(existsSync(join(cacheDir, "git-sync"))).toBe(false);
  });

  it("is not routed when the secret is the empty string", async () => {
    const handle = app({ secret: "" });

    const response = await post(handle, { "x-hub-signature-256": sign(BODY) });

    expect(response.status).toBe(404);
  });

  it("refuses to start for a secret under 32 characters, naming the variable and not the value", () => {
    const short = "short-secret-value-0123";
    expect(short.length).toBeLessThan(32);

    let message = "";
    try {
      vaultSyncWebhookFromEnv({ OBSIDIAN_TC_VAULT_GIT_WEBHOOK_SECRET: short }, tempCache());
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("OBSIDIAN_TC_VAULT_GIT_WEBHOOK_SECRET");
    expect(message).not.toContain(short);
  });

  it("derives the trigger path from the same state-dir rule loadGitSyncConfig uses", () => {
    const cacheDir = tempCache();
    const env = {
      OBSIDIAN_TC_VAULT_GIT_URL: "file:///tmp/origin.git",
      OBSIDIAN_TC_VAULT_PATH: join(cacheDir, "..", "vault"),
      OBSIDIAN_TC_CACHE_DIR: cacheDir,
    };

    const webhook = vaultSyncWebhookFromEnv(
      { ...env, OBSIDIAN_TC_VAULT_GIT_WEBHOOK_SECRET: SECRET },
      cacheDir,
    );

    expect(webhook?.triggerPath).toBe(join(loadGitSyncConfig(env).stateDir, "trigger"));
  });
});

describe("POST /hooks/vault-sync: accepted signatures", () => {
  it("returns 202 with an empty body for a valid GitHub signature and creates the trigger 0600", async () => {
    const handle = app({ secret: SECRET });
    const trigger = triggerPathOf(handle);

    const response = await post(handle, { "x-hub-signature-256": sign(BODY) });

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(statSync(trigger).mode & 0o777).toBe(0o600);
    expect(statSync(join(trigger, ".."), { throwIfNoEntry: true }).mode & 0o777).toBe(0o700);
  });

  it("advances the trigger mtime on a second valid call", async () => {
    const handle = app({ secret: SECRET });
    const trigger = triggerPathOf(handle);
    await post(handle, { "x-hub-signature-256": sign(BODY) });
    utimesSync(trigger, 1_000, 1_000);

    const response = await post(handle, { "x-hub-signature-256": sign(BODY) });

    expect(response.status).toBe(202);
    expect(statSync(trigger).mtimeMs).toBeGreaterThan(1_000_000);
  });

  it("returns 202 for a valid GitLab token", async () => {
    const handle = app({ secret: TOKEN_OK });
    const trigger = triggerPathOf(handle);

    const response = await post(handle, { "x-gitlab-token": TOKEN_OK });

    expect(response.status).toBe(202);
    expect(existsSync(trigger)).toBe(true);
  });
});

describe("POST /hooks/vault-sync: rejected auth", () => {
  const rejected: Array<[string, Record<string, string>]> = [
    ["missing headers", {}],
    ["sha256= with a wrong digest", { "x-hub-signature-256": `sha256=${"0".repeat(64)}` }],
    [
      "uppercase hex",
      { "x-hub-signature-256": sign(BODY).toUpperCase().replace("SHA256", "sha256") },
    ],
    ["truncated digest", { "x-hub-signature-256": sign(BODY).slice(0, 40) }],
    ["digest of a different body", { "x-hub-signature-256": sign(`${BODY} `) }],
    ["no sha256= prefix", { "x-hub-signature-256": sign(BODY).slice("sha256=".length) }],
    ["wrong GitLab token", { "x-gitlab-token": "wrong-token-0123456789abcdef0123456789" }],
    ["GitLab token with extra characters", { "x-gitlab-token": `${TOKEN_OK}x` }],
  ];

  it.each(rejected)(
    "answers %s with an identical 401 and leaves the trigger untouched",
    async (_, headers) => {
      const handle = app({ secret: TOKEN_OK });
      const trigger = triggerPathOf(handle);
      const baseline = await observable(await post(app({ secret: TOKEN_OK }), {}));

      const response = await post(handle, headers);

      expect(baseline.status).toBe(401);
      expect(await observable(response)).toEqual(baseline);
      expect(existsSync(trigger)).toBe(false);
    },
  );

  it("leaves an existing trigger's mtime unchanged on a rejected call", async () => {
    const handle = app({ secret: SECRET });
    const trigger = triggerPathOf(handle);
    await post(handle, { "x-hub-signature-256": sign(BODY) });
    utimesSync(trigger, 1_000, 1_000);

    const response = await post(handle, {
      "x-hub-signature-256": sign(BODY, "wrong-secret-0123456789abcdef0123"),
    });

    expect(response.status).toBe(401);
    expect(statSync(trigger).mtimeMs).toBe(1_000_000);
  });
});

describe("POST /hooks/vault-sync: body cap", () => {
  const oversized = new Uint8Array(ONE_MIB + 1).fill(0x61);

  it("answers 413 for a body of 1 MiB + 1 byte with Content-Length, leaving the trigger untouched", async () => {
    const handle = app({ secret: SECRET });

    const response = await post(
      handle,
      { "x-hub-signature-256": sign(oversized), "content-length": String(oversized.byteLength) },
      oversized,
    );

    expect(response.status).toBe(413);
    expect(existsSync(triggerPathOf(handle))).toBe(false);
  });

  it("answers 413 for a streamed oversized body with no Content-Length", async () => {
    const handle = app({ secret: SECRET });
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let sent = 0; sent < ONE_MIB + 1; sent += chunk.byteLength) controller.enqueue(chunk);
        controller.close();
      },
    });

    const response = await handle.app.request(URL, {
      method: "POST",
      headers: { ...HOST, "x-hub-signature-256": sign(BODY) },
      body: stream,
      duplex: "half",
    } as RequestInit);

    expect(response.status).toBe(413);
    expect(existsSync(triggerPathOf(handle))).toBe(false);
  });
});

describe("POST /hooks/vault-sync: request shape and host", () => {
  it("answers 403 for a disallowed Host and leaves the trigger untouched", async () => {
    const handle = app({ secret: SECRET });

    const response = await handle.app.request(URL, {
      method: "POST",
      headers: { host: "evil.example", "x-hub-signature-256": sign(BODY) },
      body: BODY,
    });

    expect(response.status).toBe(403);
    expect(existsSync(triggerPathOf(handle))).toBe(false);
  });

  it("is never 202 for GET", async () => {
    const handle = app({ secret: SECRET });

    const response = await handle.app.request(URL, {
      method: "GET",
      headers: { ...HOST, "x-hub-signature-256": sign("") },
    });

    expect(response.status).not.toBe(202);
    expect(existsSync(triggerPathOf(handle))).toBe(false);
  });
});

describe("vault-sync webhook: secrecy and isolation", () => {
  it("never writes the secret or a header value to stderr or a response", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const handle = app({ secret: TOKEN_OK });
    const digest = sign(BODY, TOKEN_OK);
    const responses: string[] = [];
    const probes: Array<Record<string, string>> = [
      {},
      { "x-hub-signature-256": `sha256=${"f".repeat(64)}` },
      { "x-gitlab-token": `${TOKEN_OK}x` },
      { "x-gitlab-token": TOKEN_OK },
    ];
    for (const headers of probes) {
      const response = await post(handle, headers);
      responses.push(await response.text());
    }

    const logged = write.mock.calls.map(([chunk]) => String(chunk)).join("");
    for (const text of [logged, ...responses]) {
      expect(text).not.toContain(TOKEN_OK);
      expect(text).not.toContain(digest);
    }
    expect(logged).toContain("reason=");
  });

  it("leaves /mcp auth unchanged while the webhook is mounted", async () => {
    const handle = app({ secret: SECRET });

    const response = await handle.app.request("http://127.0.0.1:8765/mcp", {
      method: "POST",
      headers: {
        ...HOST,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });

    expect(response.status).toBe(401);
  });

  it("agrees with loadGitSyncConfig on the state directory for the same env", () => {
    const cacheDir = randomBytes(4).toString("hex");
    const root = makeTempDir("obtc-vault-sync-agree-");
    roots.push(root);
    mkdirSync(join(root, "vault"));
    const env = {
      OBSIDIAN_TC_VAULT_GIT_URL: "file:///tmp/origin.git",
      OBSIDIAN_TC_VAULT_PATH: join(root, "vault"),
      OBSIDIAN_TC_CACHE_DIR: join(root, cacheDir),
    };

    const webhook = vaultSyncWebhookFromEnv(
      { ...env, OBSIDIAN_TC_VAULT_GIT_WEBHOOK_SECRET: SECRET },
      env.OBSIDIAN_TC_CACHE_DIR,
    );

    expect(webhook?.triggerPath).toBe(join(loadGitSyncConfig(env).stateDir, "trigger"));
  });
});
