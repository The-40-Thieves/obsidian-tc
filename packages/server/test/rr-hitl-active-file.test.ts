// Release-review findings on the active-file tools' confirmation, throttling and ACL ordering. The
// confirmation cases run through the REAL elicitation form path (createMcpServer + an MCP client
// answering `elicitation/create`), never a hand-minted token: the bug in each was only visible
// there. The ledger selects cases by the RR-<id> prefix in the test name.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { type AclConfigT, FolderAcl } from "../src/acl";
import {
  CapabilityCache,
  createBridgeClient,
  type FakeRequestInfo,
  type FakeRoute,
  fakeBridgeTransport,
} from "../src/bridge";
import { provisionCacheDb } from "../src/db/provision";
import { elicitVerifier, getDefaultElicitTtlSeconds } from "../src/elicit";
import { createElicitCodec } from "../src/elicit-request-state";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";
import { RateLimiter } from "../src/throttle";
import { registerM1Tools } from "../src/tools/m1";
import { registerM4Tools } from "../src/tools/m4";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const ACTIVE = "GET /obsidian-tc/v1/files/active";
const active = (path: string | null): FakeRoute => ({
  body: {
    ok: true,
    result: { path, extension: path ? (path.split(".").pop() ?? null) : null },
  },
});
const NOTE_A = "# A\n\nalpha\n";
const NOTE_B = "# B\n\nbravo\n";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function boot(
  opts: {
    files?: Record<string, string>;
    acl?: Partial<AclConfigT>;
    rateLimiter?: RateLimiter;
  } = {},
) {
  const root = makeTempDir("obtc-rr-active-");
  cleanups.push(() => rmTemp(root));
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  const vaultRegistry = new VaultRegistry([{ id: "test", path: root }]);
  const db = openMemoryDb();
  provisionCacheDb(db);
  const acl = new FolderAcl({ readOnly: false, defaultScopes: [], rules: [], ...opts.acl });
  const routes: Record<string, FakeRoute> = { [ACTIVE]: active(null) };
  const requests: FakeRequestInfo[] = [];
  const client = createBridgeClient({
    baseUrl: "http://127.0.0.1:27124",
    apiKey: "k",
    fetchFn: fakeBridgeTransport({ routes, onRequest: (i) => requests.push(i) }),
  });
  const capabilities = new CapabilityCache();
  capabilities.set("test", { companion: "reachable", plugins: {} });
  const registry = new ToolRegistry({
    verifyElicit: elicitVerifier,
    rootResolver: () => root,
    aclResolver: () => acl,
    ...(opts.rateLimiter ? { rateLimiter: opts.rateLimiter } : {}),
  });
  registerM1Tools(registry, {
    vaultRegistry,
    version: "test",
    startedAt: 0,
    embeddings: { provider: "none", model: "none" },
    snapshots: { enabled: true, retention: 10 },
  });
  registerM4Tools(registry, { vaultRegistry, capabilities, bridgeFor: () => client });
  const ctx = (signal?: AbortSignal): CallerContext => ({
    caller: "stdio",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "test",
    db,
    acl,
    signal,
  });
  return {
    root,
    db,
    registry,
    requests,
    ctx,
    focus: (path: string | null) => {
      routes[ACTIVE] = active(path);
    },
    call: (name: string, input: Record<string, unknown>): Promise<ToolResult> =>
      registry.dispatch(name, input, ctx()),
    read: (rel: string) => readFileSync(join(root, rel), "utf8"),
    has: (rel: string) => existsSync(join(root, rel)),
  };
}
type Booted = ReturnType<typeof boot>;

const errOf = (r: ToolResult) => {
  if (r.ok) throw new Error("expected an error result");
  return r.error;
};

/** A real MCP connection to the booted registry, stdio-shaped (legacy elicitation shim on). The
 *  client answers every `elicitation/create` with `answer` and records the form it was shown. */
async function connect(
  b: Booted,
  answer: { action: string; content?: { approve: boolean } },
  /** Runs while the form is open, before the answer goes back: lets a test change the world. */
  onForm?: () => void,
) {
  const elicitCodec = createElicitCodec(
    randomBytes(32).toString("hex"),
    getDefaultElicitTtlSeconds(),
  );
  const server = createMcpServer({
    name: "obsidian-tc",
    version: "0.0.0-test",
    registry: b.registry,
    context: b.ctx,
    visibility: { grantedScopes: new Set(["*"]) },
    elicitCodec,
    legacyElicitationShim: true,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "rr-test", version: "1.0.0" },
    { capabilities: { elicitation: {} } },
  );
  const forms: string[] = [];
  client.setRequestHandler(ElicitRequestSchema, async (req) => {
    forms.push(String((req.params as { message?: unknown }).message));
    onForm?.();
    return answer as never;
  });
  await client.connect(clientTransport);
  return {
    client,
    forms,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("RR-M4 update_active_file completes in-band confirmation through the real form", () => {
  it("RR-M4 reviewer repro: an accepting client overwrites the non-empty active note (it used to loop to approval_not_obtained and leave the note unchanged)", async () => {
    const b = boot({ files: { "Notes/a.md": NOTE_A } });
    b.focus("Notes/a.md");
    const conn = await connect(b, { action: "accept", content: { approve: true } });
    try {
      const res = await conn.client.callTool({
        name: "update_active_file",
        arguments: { vault: "test", content: "# New\n" },
      });
      expect(res.isError, JSON.stringify(res)).toBeFalsy();
      expect(b.read("Notes/a.md")).toBe("# New\n");
      expect(conn.forms).toHaveLength(1);
    } finally {
      await conn.close();
    }
  });

  it("RR-M4 a declined form still writes nothing and offers no mint route", async () => {
    const b = boot({ files: { "Notes/a.md": NOTE_A } });
    b.focus("Notes/a.md");
    const conn = await connect(b, { action: "decline" });
    try {
      const res = await conn.client.callTool({
        name: "update_active_file",
        arguments: { vault: "test", content: "# New\n" },
      });
      expect(res.isError).toBe(true);
      expect(b.read("Notes/a.md")).toBe(NOTE_A);
      const text = (res.content as Array<{ text: string }>)[0]?.text ?? "";
      expect(text).toContain("Do not retry it and do not mint a token");
      expect(text).not.toContain("confirm with:");
    } finally {
      await conn.close();
    }
  });
});

describe("RR-D1 a decline is a hard stop whatever the gate says afterwards", () => {
  it("RR-D1 update_active_file: the overwrite target is removed while the prompt is open, a decline still writes nothing", async () => {
    const b = boot({ files: { "Notes/a.md": NOTE_A } });
    b.focus("Notes/a.md");
    const conn = await connect(b, { action: "decline" }, () => rmSync(join(b.root, "Notes/a.md")));
    try {
      const res = await conn.client.callTool({
        name: "update_active_file",
        arguments: { vault: "test", content: "# New\n" },
      });
      expect(res.isError).toBe(true);
      expect(conn.forms).toHaveLength(1);
      expect(b.has("Notes/a.md")).toBe(false);
      const text = (res.content as Array<{ text: string }>)[0]?.text ?? "";
      expect(text).toContain("Do not retry it and do not mint a token");
    } finally {
      await conn.close();
    }
  });

  it("RR-D1 write_note: the gate condition flips while the prompt is open, a decline runs no handler", async () => {
    const b = boot({ files: { "a.md": NOTE_A } });
    const conn = await connect(b, { action: "decline" }, () => rmSync(join(b.root, "a.md")));
    try {
      const res = await conn.client.callTool({
        name: "write_note",
        arguments: { vault: "test", path: "a.md", content: "new", mode: "overwrite" },
      });
      expect(res.isError).toBe(true);
      expect(conn.forms).toHaveLength(1);
      expect(b.has("a.md")).toBe(false);
      const sc = (res as { structuredContent?: { details?: { reason?: string } } })
        .structuredContent;
      expect(sc?.details?.reason).toBe("approval_declined");
    } finally {
      await conn.close();
    }
  });
});

describe("RR-M5 the confirmation names the resolved note", () => {
  it("RR-M5 reviewer repro: focus secret.md, delete_active_file -> the form text and the error details name the path", async () => {
    const b = boot({ files: { "Notes/secret.md": NOTE_A } });
    b.focus("Notes/secret.md");
    const first = errOf(await b.call("delete_active_file", { vault: "test" }));
    expect(first.code).toBe("elicit_required");
    expect(first.details).toMatchObject({ path: "Notes/secret.md", tool: "delete_active_file" });

    const conn = await connect(b, { action: "accept", content: { approve: true } });
    try {
      const res = await conn.client.callTool({
        name: "delete_active_file",
        arguments: { vault: "test" },
      });
      expect(res.isError, JSON.stringify(res)).toBeFalsy();
      expect(conn.forms).toHaveLength(1);
      expect(conn.forms[0]).toContain("Notes/secret.md");
      expect(b.has("Notes/secret.md")).toBe(false);
    } finally {
      await conn.close();
    }
  });

  it("RR-M5 update_active_file's form and error name the path too", async () => {
    const b = boot({ files: { "Notes/a.md": NOTE_A } });
    b.focus("Notes/a.md");
    const first = errOf(await b.call("update_active_file", { vault: "test", content: "x" }));
    expect(first.details).toMatchObject({ path: "Notes/a.md" });
    const conn = await connect(b, { action: "decline" });
    try {
      await conn.client.callTool({
        name: "update_active_file",
        arguments: { vault: "test", content: "x" },
      });
      expect(conn.forms[0]).toContain("Notes/a.md");
    } finally {
      await conn.close();
    }
  });

  it("RR-M5 the args hash binds the resolved path: the same call on another active note hashes differently", async () => {
    const b = boot({ files: { "Notes/a.md": NOTE_A, "Notes/b.md": NOTE_B } });
    b.focus("Notes/a.md");
    const forA = errOf(await b.call("delete_active_file", { vault: "test" }));
    b.focus("Notes/b.md");
    const forB = errOf(await b.call("delete_active_file", { vault: "test" }));
    const hash = (e: typeof forA) => (e.details as { args_hash: string }).args_hash;
    expect(hash(forA)).not.toBe(hash(forB));
    expect(forB.details).toMatchObject({ path: "Notes/b.md" });
  });
});

describe("RR-L4 a throttled request never reaches the companion", () => {
  it("RR-L4 reviewer repro: burst 1, get_active_file twice -> the second is throttled and the bridge saw ONE request", async () => {
    const tier = { perMinute: 1, burst: 1 };
    const rateLimiter = new RateLimiter({
      read: tier,
      write: tier,
      bulk: tier,
      execute: tier,
      admin: tier,
    } as never);
    const b = boot({ files: { "Notes/a.md": NOTE_A }, rateLimiter });
    b.focus("Notes/a.md");
    expect((await b.call("get_active_file", { vault: "test" })).ok).toBe(true);
    expect(b.requests).toHaveLength(1);
    const second = await b.call("get_active_file", { vault: "test" });
    expect(errOf(second).code).toBe("throttled");
    expect(b.requests).toHaveLength(1);
  });
});

describe("RR-L5 the ACL answers before the markdown-type check", () => {
  it("RR-L5 reviewer repro: a denied secret.md and a denied secret.canvas get the SAME refusal", async () => {
    const b = boot({
      files: { "Private/secret.md": "s", "Private/secret.canvas": "{}" },
      acl: { writePaths: ["Notes/**"], deletePaths: ["Notes/**"] },
    });
    for (const name of ["update_active_file", "append_active_file", "delete_active_file"]) {
      const input =
        name === "delete_active_file" ? { vault: "test" } : { vault: "test", content: "x" };
      b.focus("Private/secret.md");
      const md = errOf(await b.call(name, input));
      b.focus("Private/secret.canvas");
      const canvas = errOf(await b.call(name, input));
      expect(md.code, name).toBe("acl_denied");
      expect(canvas.code, name).toBe("acl_denied");
      expect(canvas.message, name).toBe(md.message);
    }
  });

  it("RR-L5 control: an ALLOWED non-markdown active file is still refused as not_markdown", async () => {
    const b = boot({ files: { "Notes/plan.canvas": "{}" } });
    b.focus("Notes/plan.canvas");
    const e = errOf(await b.call("update_active_file", { vault: "test", content: "x" }));
    expect(e.code).toBe("invalid_input");
    expect(e.details).toMatchObject({ reason: "not_markdown" });
  });
});
