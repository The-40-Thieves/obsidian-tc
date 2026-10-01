// What one write-provenance record says, and how far each field can be trusted.
//
// Records come from the real dispatch choke point (ToolRegistry + ProvenanceRecorder) with a probe
// tool that really writes a file, so the digests are checked against bytes on disk. The trust
// tagging is checked end to end: through the MCP server with `_meta` claims (self_reported), and
// through the HTTP transport with a verified jwt versus `auth.mode: none` (authVerified).

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { SignJWT } from "jose";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";
import { resolveHostId } from "../src/provenance/recorder";
import { extractClaimedProvenance, PROVENANCE_META_KEY } from "../src/provenance/types";
import { startHttp } from "../src/transports/http";
import { CLOCK0, provenanceFixture, rowsFor } from "./provenance-helpers";
import { stallTimeout } from "./stall-timeouts";
import { makeTempDir, rmTemp } from "./tmp";

const root = makeTempDir("obtc-prov-rec-");
const outside = makeTempDir("obtc-prov-out-");
afterAll(() => {
  rmTemp(root);
  rmTemp(outside);
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
type Fx = Awaited<ReturnType<typeof provenanceFixture>>;
const records = (fx: Fx) => rowsFor(fx.db).map((r) => JSON.parse(r.body));

/** A mutating probe tool: writes `content` to `path` inside the vault, then optionally throws. */
function probeRegistry(fx: Fx, opts: { throwAfter?: boolean; throwBefore?: boolean } = {}) {
  const registry = new ToolRegistry({ provenance: fx.recorder, rootResolver: () => root });
  registry.register({
    name: "probe_write",
    description: "test-only write",
    inputSchema: z.object({ path: z.string(), content: z.string().default("") }),
    requiredScopes: ["write:notes"],
    pathAcl: (i: { path: string }) => [{ op: "write" as const, path: i.path }],
    handler: (i: { path: string; content: string }) => {
      if (opts.throwBefore) throw new Error("fails before writing");
      mkdirSync(join(root, i.path, ".."), { recursive: true });
      writeFileSync(join(root, i.path), i.content);
      if (opts.throwAfter) throw new Error("fails after writing");
      return { ok: true };
    },
  } as never);
  return registry;
}

const ctxFor = (fx: Fx, over: Partial<CallerContext> = {}): CallerContext => ({
  caller: "stdio",
  authenticated: true,
  grantedScopes: new Set(["write:notes"]),
  vaultId: "v1",
  db: fx.db,
  ...over,
});

describe("a record's content", () => {
  it("carries the tool, the named path and real before/after digests, never the content", async () => {
    const fx = await provenanceFixture();
    const reg = probeRegistry(fx);
    const secret = "SECRET-NOTE-BODY-7f3a";
    const r1 = await reg.dispatch("probe_write", { path: "a/one.md", content: secret }, ctxFor(fx));
    expect(r1.ok).toBe(true);
    const r2 = await reg.dispatch("probe_write", { path: "a/one.md", content: "v2" }, ctxFor(fx));
    expect(r2.ok).toBe(true);
    const [first, second] = records(fx);
    expect(first).toMatchObject({
      v: 1,
      vault: "v1",
      seq: 1,
      tool: "probe_write",
      outcome: "ok",
      paths: [{ path: "a/one.md", before: "absent", after: sha(secret) }],
    });
    expect(second.paths).toEqual([{ path: "a/one.md", before: sha(secret), after: sha("v2") }]);
    expect(second.prev).toBe(rowsFor(fx.db)[0]?.hash);
    for (const row of rowsFor(fx.db)) {
      expect(row.body).not.toContain(secret);
      expect(row.body).not.toContain('v2"');
    }
  });

  it("an idempotent replay is one record, not two", async () => {
    const fx = await provenanceFixture();
    const reg = new ToolRegistry({ provenance: fx.recorder, rootResolver: () => root });
    let runs = 0;
    reg.register({
      name: "probe_idem",
      description: "test-only",
      inputSchema: z.object({ path: z.string(), idempotency_key: z.string() }),
      acceptsIdempotencyKey: true,
      requiredScopes: ["write:notes"],
      pathAcl: (i: { path: string }) => [{ op: "write" as const, path: i.path }],
      handler: (i: { path: string }) => {
        runs++;
        writeFileSync(join(root, i.path), `run ${runs}`);
        return { ok: true };
      },
    } as never);
    const input = { path: "idem.md", idempotency_key: "k-1" };
    await reg.dispatch("probe_idem", input, ctxFor(fx));
    await reg.dispatch("probe_idem", input, ctxFor(fx));
    expect(runs).toBe(1);
    expect(rowsFor(fx.db)).toHaveLength(1);
  });
});

describe("which calls leave a record", () => {
  it("a denied call (missing scope) writes no record and touches nothing", async () => {
    const fx = await provenanceFixture();
    const res = await probeRegistry(fx).dispatch(
      "probe_write",
      { path: "denied.md", content: "x" },
      ctxFor(fx, { grantedScopes: new Set(["read:notes"]) }),
    );
    expect(res.ok).toBe(false);
    expect(rowsFor(fx.db)).toHaveLength(0);
  });

  it("an invalid-input call writes no record", async () => {
    const fx = await provenanceFixture();
    const res = await probeRegistry(fx).dispatch("probe_write", { content: 5 }, ctxFor(fx));
    expect(res.ok).toBe(false);
    expect(rowsFor(fx.db)).toHaveLength(0);
  });

  it("a handler that throws without changing a named path writes no record", async () => {
    const fx = await provenanceFixture();
    const res = await probeRegistry(fx, { throwBefore: true }).dispatch(
      "probe_write",
      { path: "never.md", content: "x" },
      ctxFor(fx),
    );
    expect(res.ok).toBe(false);
    expect(rowsFor(fx.db)).toHaveLength(0);
  });

  it("a handler that writes and THEN throws is recorded, outcome error, digests moved", async () => {
    const fx = await provenanceFixture();
    const res = await probeRegistry(fx, { throwAfter: true }).dispatch(
      "probe_write",
      { path: "partial.md", content: "half" },
      ctxFor(fx),
    );
    expect(res.ok).toBe(false);
    expect(records(fx)).toHaveLength(1);
    expect(records(fx)[0]).toMatchObject({
      outcome: "error",
      paths: [{ path: "partial.md", before: "absent", after: sha("half") }],
    });
  });

  it("a read-only tool writes no record", async () => {
    const fx = await provenanceFixture();
    const reg = new ToolRegistry({ provenance: fx.recorder, rootResolver: () => root });
    reg.register({
      name: "probe_read",
      description: "test-only",
      inputSchema: z.object({}),
      requiredScopes: ["read:notes"],
      handler: () => ({ ok: true }),
    } as never);
    await reg.dispatch("probe_read", {}, ctxFor(fx, { grantedScopes: new Set(["read:notes"]) }));
    expect(rowsFor(fx.db)).toHaveLength(0);
  });

  it("a recording fault never fails the write it describes", async () => {
    const fx = await provenanceFixture();
    fx.db.exec("DROP TABLE write_provenance_heads");
    const faults: unknown[] = [];
    const { ProvenanceRecorder } = await import("../src/provenance/recorder");
    const recorder = new ProvenanceRecorder({
      db: fx.db,
      host: "h",
      serverVersion: "0",
      onError: (_t, _v, e) => faults.push(e),
    });
    const reg = new ToolRegistry({ provenance: recorder, rootResolver: () => root });
    reg.register({
      name: "probe_w",
      description: "test-only",
      inputSchema: z.object({}),
      requiredScopes: ["write:notes"],
      pathAcl: () => [{ op: "write" as const, path: "failopen.md" }],
      handler: () => {
        writeFileSync(join(root, "failopen.md"), "kept");
        return { ok: true };
      },
    } as never);
    const res = await reg.dispatch("probe_w", {}, ctxFor(fx));
    expect(res.ok).toBe(true);
    expect(readFileSync(join(root, "failopen.md"), "utf8")).toBe("kept");
    expect(faults).toHaveLength(1);
  });
});

describe("trust tagging", () => {
  it("an unauthenticated caller label is filed apart from `verified`", async () => {
    const fx = await provenanceFixture();
    await probeRegistry(fx).dispatch(
      "probe_write",
      { path: "t1.md" },
      ctxFor(fx, { caller: "stdio", transport: "stdio", sessionId: "sess-1" }),
    );
    const [rec] = records(fx);
    expect(rec.verified).toEqual({
      host: "host-test",
      server_version: "0.0.0-test",
      transport: "stdio",
      session_id: "sess-1",
    });
    expect(rec.unauthenticated).toEqual({ principal: "stdio" });
  });

  it("a verified principal and persona land under `verified` only", async () => {
    const fx = await provenanceFixture();
    await probeRegistry(fx).dispatch(
      "probe_write",
      { path: "t2.md" },
      ctxFor(fx, { caller: "agent-7", persona: "editor", transport: "http", authVerified: true }),
    );
    const [rec] = records(fx);
    expect(rec.verified).toMatchObject({ principal: "agent-7", persona: "editor" });
    expect(rec.unauthenticated).toEqual({});
  });

  it("a persona without authVerified is NOT recorded as verified", async () => {
    const fx = await provenanceFixture();
    await probeRegistry(fx).dispatch(
      "probe_write",
      { path: "t3.md" },
      ctxFor(fx, { caller: "someone", persona: "admin", transport: "http" }),
    );
    const [rec] = records(fx);
    expect(rec.verified.principal).toBeUndefined();
    expect(rec.verified.persona).toBeUndefined();
    expect(rec.unauthenticated).toEqual({ principal: "someone" });
  });

  it("client-claimed fields are filed under self_reported", async () => {
    const fx = await provenanceFixture();
    await probeRegistry(fx).dispatch(
      "probe_write",
      { path: "t4.md" },
      ctxFor(fx, {
        claimedProvenance: { model: "m-1", project: "p", agent: "a", machine: "box" },
        clientInfo: { name: "cli", version: "2" },
      }),
    );
    const [rec] = records(fx);
    expect(rec.self_reported).toEqual({
      model: "m-1",
      project: "p",
      agent: "a",
      machine: "box",
      client: { name: "cli", version: "2" },
    });
    expect(JSON.stringify(rec.verified)).not.toContain("m-1");
  });
});

describe("_meta claims end to end (MCP server)", () => {
  it("io.obsidian-tc/provenance and clientInfo become self_reported; an injected `principal` is ignored", async () => {
    const fx = await provenanceFixture();
    const server = createMcpServer({
      name: "x",
      version: "0",
      registry: probeRegistry(fx),
      context: (): CallerContext => ctxFor(fx, { caller: "stdio", transport: "stdio" }),
      visibility: { grantedScopes: new Set(["*"]) },
      facadeMode: "flat",
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "claimed-client", version: "9.9" });
    await client.connect(ct);
    const res = await client.callTool({
      name: "probe_write",
      arguments: { path: "meta.md", content: "m" },
      _meta: {
        [PROVENANCE_META_KEY]: {
          model: "claimed-model",
          project: "proj",
          principal: "admin",
          verified: { principal: "root" },
        },
      },
    });
    await client.close();
    await server.close();
    expect((res as { isError?: boolean }).isError).not.toBe(true);
    const [rec] = records(fx);
    expect(rec.self_reported).toMatchObject({
      model: "claimed-model",
      project: "proj",
      client: { name: "claimed-client", version: "9.9" },
    });
    expect(rec.self_reported.principal).toBeUndefined();
    expect(rec.verified.principal).toBeUndefined();
    expect(rec.unauthenticated).toEqual({ principal: "stdio" });
  });
});

describe("authVerified only after jwt/oidc acceptance (HTTP transport)", () => {
  const SECRET = "test-only-secret-not-a-real-credential-0123456789";
  const MODERN = "2026-07-28";

  async function boot(mode: "jwt" | "none", fx: Fx) {
    const auth: ServerConfig["auth"] = ServerConfigSchema.parse({
      vaults: [{ id: "v1", path: root }],
      auth:
        mode === "jwt"
          ? { mode: "jwt", jwtSecret: SECRET, audience: "http://test", tokenTtlSeconds: 3600 }
          : { mode: "none" },
    }).auth;
    return startHttp({
      name: "obsidian-tc",
      version: "0.0.0-test",
      registry: probeRegistry(fx),
      auth,
      db: fx.db,
      vaultId: "v1",
      acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
      host: "127.0.0.1",
      port: 0,
    });
  }

  async function call(port: number, jwt: string | undefined, path: string) {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
        "mcp-protocol-version": MODERN,
        "mcp-method": "tools/call",
        "mcp-name": "probe_write",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "probe_write",
          arguments: { path, content: "h" },
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MODERN,
            "io.modelcontextprotocol/clientInfo": { name: "http-client", version: "1" },
            "io.modelcontextprotocol/clientCapabilities": {},
            [PROVENANCE_META_KEY]: { model: "http-claimed" },
          },
        },
      }),
    });
    return res.status;
  }

  const token = (sub: string, secret = SECRET) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      sub,
      scopes: ["write:notes"],
      aud: "http://test",
      iat: now,
      exp: now + 600,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .sign(new TextEncoder().encode(secret));
  };

  it(
    "a verified token: principal is `verified`; the claimed model stays self_reported",
    async () => {
      const fx = await provenanceFixture();
      const h = await boot("jwt", fx);
      try {
        expect(await call(h.port, await token("agent-http"), "h1.md")).toBe(200);
      } finally {
        await h.close();
      }
      const [rec] = records(fx);
      expect(rec.verified).toMatchObject({ principal: "agent-http", transport: "http" });
      expect(rec.unauthenticated).toEqual({});
      expect(rec.self_reported).toMatchObject({
        model: "http-claimed",
        client: { name: "http-client", version: "1" },
      });
    },
    stallTimeout(30_000),
  );

  it(
    "a token that fails verification reaches no write and leaves no record",
    async () => {
      const fx = await provenanceFixture();
      const h = await boot("jwt", fx);
      let status = 0;
      try {
        status = await call(
          h.port,
          await token("intruder", "a-different-secret-0123456789abcdef"),
          "h2.md",
        );
      } finally {
        await h.close();
      }
      expect(status).toBe(401);
      expect(rowsFor(fx.db)).toHaveLength(0);
    },
    stallTimeout(30_000),
  );

  it(
    "auth.mode none: the loopback label is unauthenticated, never verified",
    async () => {
      const fx = await provenanceFixture();
      const h = await boot("none", fx);
      try {
        expect(await call(h.port, undefined, "h3.md")).toBe(200);
      } finally {
        await h.close();
      }
      const [rec] = records(fx);
      expect(rec.verified.principal).toBeUndefined();
      expect(rec.unauthenticated).toEqual({ principal: "http-local" });
    },
    stallTimeout(30_000),
  );
});

describe("path guard: what a digest may read", () => {
  async function digestsFor(fx: Fx, path: string) {
    const reg = new ToolRegistry({ provenance: fx.recorder, rootResolver: () => root });
    reg.register({
      name: "probe_noop",
      description: "test-only",
      inputSchema: z.object({}),
      requiredScopes: ["write:notes"],
      pathAcl: () => [{ op: "write" as const, path }],
      handler: () => ({ ok: true }),
    } as never);
    // Drive the recorder directly: the dispatch-level path ACL would refuse an escaping path
    // before the handler, and here the recorder's own containment is what is under test.
    const def = reg.list().find((d) => d.name === "probe_noop");
    const pending = await fx.recorder.begin(def as never, {}, ctxFor(fx), root);
    await fx.recorder.commit(pending, "ok");
    return records(fx).at(-1).paths[0];
  }

  it("a symlink inside the vault to a file OUTSIDE it is `unhashable` and is never read", async () => {
    const fx = await provenanceFixture();
    const secretOutside = "outside-the-vault-bytes";
    writeFileSync(join(outside, "secret.txt"), secretOutside);
    symlinkSync(join(outside, "secret.txt"), join(root, "escape-link.md"));
    const entry = await digestsFor(fx, "escape-link.md");
    expect(entry).toEqual({ path: "escape-link.md", before: "unhashable", after: "unhashable" });
    expect(JSON.stringify(entry)).not.toContain(sha(secretOutside));
  });

  it("a symlinked DIRECTORY out of the vault is `unhashable` for files beneath it", async () => {
    const fx = await provenanceFixture();
    mkdirSync(join(outside, "dir"), { recursive: true });
    writeFileSync(join(outside, "dir", "f.md"), "deep outside");
    symlinkSync(join(outside, "dir"), join(root, "dir-link"));
    const entry = await digestsFor(fx, "dir-link/f.md");
    expect(entry.before).toBe("unhashable");
    expect(entry.after).toBe("unhashable");
  });

  it("a sibling NAME that merely starts with two dots is hashed normally", async () => {
    const fx = await provenanceFixture();
    mkdirSync(join(root, "..foo"), { recursive: true });
    writeFileSync(join(root, "..foo", "x.md"), "dots");
    const entry = await digestsFor(fx, "..foo/x.md");
    expect(entry).toEqual({ path: "..foo/x.md", before: sha("dots"), after: sha("dots") });
  });

  it("a path segment `..b` under a folder is hashed normally too", async () => {
    const fx = await provenanceFixture();
    mkdirSync(join(root, "a"), { recursive: true });
    writeFileSync(join(root, "a", "..b"), "seg");
    const entry = await digestsFor(fx, "a/..b");
    expect(entry.after).toBe(sha("seg"));
  });

  it("a traversing path is `unhashable`, never read", async () => {
    const fx = await provenanceFixture();
    writeFileSync(join(outside, "t.md"), "traverse");
    const up = `../${join(outside, "t.md").split("/").slice(-2).join("/")}`;
    const entry = await digestsFor(fx, up);
    expect(entry.after).toBe("unhashable");
  });
});

describe("small pure helpers", () => {
  it("resolveHostId: hashed is stable, 32 hex, and does not contain the hostname", () => {
    const a = resolveHostId({ mode: "hashed" });
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(resolveHostId({ mode: "hashed" })).toBe(a);
    expect(a).not.toContain(hostname());
  });

  it("resolveHostId: label mode records the label verbatim", () => {
    expect(resolveHostId({ mode: "label", label: "prod-1" })).toBe("prod-1");
  });

  it("extractClaimedProvenance is bounded and strict", () => {
    const key = PROVENANCE_META_KEY;
    expect(extractClaimedProvenance(undefined)).toBeUndefined();
    expect(extractClaimedProvenance(null)).toBeUndefined();
    expect(extractClaimedProvenance({})).toBeUndefined();
    expect(extractClaimedProvenance({ [key]: "str" })).toBeUndefined();
    expect(extractClaimedProvenance({ [key]: ["model"] })).toBeUndefined();
    expect(extractClaimedProvenance({ [key]: { model: 5, project: "" } })).toBeUndefined();
    // Over-long values are dropped, not truncated; unknown keys are never lifted.
    expect(
      extractClaimedProvenance({
        [key]: { model: "x".repeat(200), agent: "ok", principal: "root" },
      }),
    ).toEqual({ agent: "ok" });
    // First bag carrying a usable block wins.
    expect(extractClaimedProvenance({}, { [key]: { machine: "m" } })).toEqual({ machine: "m" });
    expect(CLOCK0).toBeGreaterThan(0);
  });
});
