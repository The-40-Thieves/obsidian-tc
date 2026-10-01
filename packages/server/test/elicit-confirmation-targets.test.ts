// replay_drift (elicit-replay-drift.test.ts) binds a confirmation to the vault paths a tool declares
// through `pathAcl`. Eight HITL-gated tools declare none, so they bound on args_hash alone. These
// tests cover the per-tool `confirmationTargets` declaration that closes that: for each tool with a
// real target, raise the request, change the state it was about, submit the ORIGINAL token and
// assert `replay_drift` with the action NOT applied. The two tools whose side effects are opaque
// Obsidian state declare "none" and must keep working on args_hash. Also: the registration guard
// (a HITL-gated tool with no declaration cannot register) and the headless-mint decision.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildFullRegistry } from "../scripts/docgen/build-registry";
import { FolderAcl } from "../src/acl";
import {
  CapabilityCache,
  createBridgeClient,
  type FakeRequestInfo,
  fakeBridgeTransport,
} from "../src/bridge";
import { CliError } from "../src/cli/args";
import {
  type ElicitMintCmd,
  mintElicitAudited,
  mintElicitForRaisedRequest,
  planElicitMint,
} from "../src/cli/commands/elicit-mint";
import { provisionCacheDb } from "../src/db/provision";
import { elicitVerifier, issueElicitToken } from "../src/elicit";
import { type CallerContext, type ToolDefinition, ToolRegistry } from "../src/mcp/registry";
import { isHitlGated } from "../src/mcp/registry/hitl-declaration";
import { RateLimiter } from "../src/throttle";
import { registerM1Tools } from "../src/tools/m1";
import { registerM4Tools } from "../src/tools/m4";
import { registerM5Tools } from "../src/tools/m5";
import { registerM6Tools } from "../src/tools/m6";
import { VaultRegistry } from "../src/vault/registry";
import { cacheTraceRelPath, genSessionId, insertSession } from "../src/workspace/sessions";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const VAULT = "test";
const CALLER = "test";
const NO_THROTTLE = {
  read: { perMinute: 1e6, burst: 1e6 },
  write: { perMinute: 1e6, burst: 1e6 },
  bulk: { perMinute: 1e6, burst: 1e6 },
  execute: { perMinute: 1e6, burst: 1e6 },
  admin: { perMinute: 1e6, burst: 1e6 },
};
const ZERO_BY_VERDICT = {
  runnable: 0,
  no_capture: 0,
  redacted: 0,
  truncated: 0,
  skipped_mutating: 0,
  unparseable: 0,
  refused_by_policy: 0,
  served_from_cache: 0,
};
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function boot(files: Record<string, string> = {}) {
  const root = makeTempDir("obtc-targets-");
  const cacheDir = makeTempDir("obtc-targets-cache-");
  const write = (rel: string, content: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  };
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  const db = openMemoryDb();
  provisionCacheDb(db);
  const vaultRegistry = new VaultRegistry([{ id: VAULT, name: VAULT, path: root }]);
  const rateLimiter = new RateLimiter(NO_THROTTLE as never);
  const bridgeRequests: FakeRequestInfo[] = [];
  const capabilities = new CapabilityCache();
  capabilities.set(VAULT, {
    companion: "reachable",
    plugins: {
      "text-extractor": { installed: true },
      quickadd: { installed: true },
      git: { installed: true },
    },
  });
  const client = createBridgeClient({
    baseUrl: "http://127.0.0.1:27124",
    apiKey: "k",
    fetchFn: fakeBridgeTransport({
      routes: {
        "POST /obsidian-tc/v1/ocr/bulk": { body: { ok: true, result: { processed: 1 } } },
        "POST /obsidian-tc/v1/git/commit": { body: { ok: true, result: { sha: "abc" } } },
        "POST /obsidian-tc/v1/quickadd/trigger": { body: { ok: true, result: { ok: true } } },
        "POST /obsidian-tc/v1/commands/execute": {
          body: { ok: true, result: { fired_at: "t", plugin_response: { ok: true } } },
        },
      },
      onRequest: (i) => bridgeRequests.push(i),
    }),
  });
  const rerunCalls: unknown[] = [];
  const registry = new ToolRegistry({
    verifyElicit: elicitVerifier,
    rateLimiter,
    rootResolver: (id) => (id === VAULT ? root : undefined),
  });
  registerM1Tools(registry, {
    vaultRegistry,
    version: "test",
    startedAt: 0,
    embeddings: { provider: "ollama", model: "nomic-embed-text" },
  });
  registerM4Tools(registry, {
    vaultRegistry,
    capabilities,
    bridgeFor: () => client,
    commandPolicy: () => ({ enabled: true, allowlist: ["editor:save-file"] }),
  });
  registerM5Tools(registry, {
    cacheDir,
    vaultRegistry,
    memoryFolder: () => "memory",
    traceFolder: () => ".obsidian-tc/traces",
  });
  registerM6Tools(registry, {
    vaultRegistry,
    rateLimiter,
    version: "test",
    startedAt: 0,
    authMode: "none",
    throttle: {} as never,
    observability: { otel: false, prometheus: false, morgiana: false },
    embeddingsProvider: "ollama",
    governorMaxResponseBytes: 1e6,
    cacheDir,
    rerun: async (params) => {
      rerunCalls.push(params);
      return {
        records: [],
        summary: { total: 0, runnable: 0, diverged: 0, byVerdict: ZERO_BY_VERDICT },
      };
    },
  });
  const acl = new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] });
  const ctx = (over: Partial<CallerContext> = {}): CallerContext => ({
    caller: CALLER,
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: VAULT,
    db,
    acl,
    ...over,
  });
  return {
    root,
    cacheDir,
    db,
    registry,
    bridgeRequests,
    rerunCalls,
    write,
    read: (rel: string) => readFileSync(join(root, rel), "utf8"),
    call: (name: string, input: Record<string, unknown>, over?: Partial<CallerContext>) =>
      registry.dispatch(name, input, ctx(over)),
    cleanup: () => {
      rmTemp(root);
      rmTemp(cacheDir);
    },
  };
}

type Booted = ReturnType<typeof boot>;
type Result = Awaited<ReturnType<Booted["call"]>>;

function hashOf(r: Result): string {
  if (r.ok) throw new Error("expected an error result");
  expect(r.error.code).toBe("elicit_required");
  return (r.error.details as { args_hash: string }).args_hash;
}

function expectDrift(r: Result): void {
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.code).toBe("replay_drift");
  expect(r.error.retryable).toBe(false);
}

/** Raise the request, mint a token for it, return the token. */
async function raise(b: Booted, tool: string, input: Record<string, unknown>): Promise<string> {
  const hash = hashOf(await b.call(tool, input));
  return issueElicitToken(b.db, { vaultId: VAULT, toolName: tool, argsHash: hash, caller: CALLER });
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    env: GIT_ENV,
    stdio: "pipe",
  }).toString();

describe("confirmationTargets: rewrite_link binds the set of notes it will touch", () => {
  const input = { vault: VAULT, from_target: "old", to_target: "new", dry_run: false };

  it("a note it would rewrite changing after the request is drift; nothing is rewritten", async () => {
    const b = boot({ "a.md": "see [[old]]", "b.md": "also [[old]]" });
    try {
      const token = await raise(b, "rewrite_link", input);
      b.write("b.md", "also [[old]] and edited meanwhile");
      expectDrift(await b.call("rewrite_link", input, { elicitToken: token }));
      expect(b.read("a.md")).toBe("see [[old]]");
      expect(b.read("b.md")).toBe("also [[old]] and edited meanwhile");
    } finally {
      b.cleanup();
    }
  });

  it("a NEW note gaining a link to the target grows the set: drift", async () => {
    const b = boot({ "a.md": "see [[old]]" });
    try {
      const token = await raise(b, "rewrite_link", input);
      b.write("c.md", "late [[old]]");
      expectDrift(await b.call("rewrite_link", input, { elicitToken: token }));
      expect(b.read("a.md")).toBe("see [[old]]");
      expect(b.read("c.md")).toBe("late [[old]]");
    } finally {
      b.cleanup();
    }
  });

  it("control: unchanged notes still redeem", async () => {
    const b = boot({ "a.md": "see [[old]]" });
    try {
      const token = await raise(b, "rewrite_link", input);
      const res = await b.call("rewrite_link", input, { elicitToken: token });
      expect(res.ok).toBe(true);
      expect(b.read("a.md")).toBe("see [[new]]");
    } finally {
      b.cleanup();
    }
  });
});

describe("confirmationTargets: ocr_bulk binds the attachments it will read", () => {
  it("an attachment replaced after the request is drift; the bridge is never called", async () => {
    const b = boot({ "img/a.png": "one", "img/b.png": "two" });
    try {
      const input = { vault: VAULT, root: "img" };
      const token = await raise(b, "ocr_bulk", input);
      b.write("img/a.png", "replaced scan");
      expectDrift(await b.call("ocr_bulk", input, { elicitToken: token }));
      expect(b.bridgeRequests).toHaveLength(0);
    } finally {
      b.cleanup();
    }
  });

  it("an attachment added to the walked folder is drift", async () => {
    const b = boot({ "img/a.png": "one" });
    try {
      const input = { vault: VAULT, root: "img" };
      const token = await raise(b, "ocr_bulk", input);
      b.write("img/new.png", "three");
      expectDrift(await b.call("ocr_bulk", input, { elicitToken: token }));
      expect(b.bridgeRequests).toHaveLength(0);
    } finally {
      b.cleanup();
    }
  });

  it("control: unchanged attachments redeem and reach the bridge", async () => {
    const b = boot({ "img/a.png": "one" });
    try {
      const input = { vault: VAULT, paths: ["img/a.png"] };
      const token = await raise(b, "ocr_bulk", input);
      expect((await b.call("ocr_bulk", input, { elicitToken: token })).ok).toBe(true);
      expect(b.bridgeRequests).toHaveLength(1);
    } finally {
      b.cleanup();
    }
  });
});

describe("confirmationTargets: git_commit binds HEAD and the index", () => {
  const input = { vault: VAULT, message: "snapshot" };
  const repo = (b: Booted) => {
    git(b.root, "init", "-q", "-b", "main");
    b.write("a.md", "one");
    git(b.root, "add", "a.md");
    git(b.root, "commit", "-q", "-m", "first");
    b.write("staged.md", "staged");
    git(b.root, "add", "staged.md");
  };

  it("something staged after the request is drift; nothing is committed", async () => {
    const b = boot();
    try {
      repo(b);
      const token = await raise(b, "git_commit", input);
      b.write("late.md", "late");
      git(b.root, "add", "late.md");
      expectDrift(await b.call("git_commit", input, { elicitToken: token }));
      expect(b.bridgeRequests).toHaveLength(0);
    } finally {
      b.cleanup();
    }
  });

  it("staged content changing under the same path is drift", async () => {
    const b = boot();
    try {
      repo(b);
      const token = await raise(b, "git_commit", input);
      b.write("staged.md", "restaged with different bytes");
      git(b.root, "add", "staged.md");
      expectDrift(await b.call("git_commit", input, { elicitToken: token }));
      expect(b.bridgeRequests).toHaveLength(0);
    } finally {
      b.cleanup();
    }
  });

  it("HEAD moving is drift", async () => {
    const b = boot();
    try {
      repo(b);
      const token = await raise(b, "git_commit", input);
      git(b.root, "commit", "-q", "-m", "somebody else committed");
      expectDrift(await b.call("git_commit", input, { elicitToken: token }));
      expect(b.bridgeRequests).toHaveLength(0);
    } finally {
      b.cleanup();
    }
  });

  it("control: an index refreshed by `git status` (stat data only) is NOT drift", async () => {
    const b = boot();
    try {
      repo(b);
      const token = await raise(b, "git_commit", input);
      b.write("a.md", "one"); // same bytes, new mtime: the index stat cache changes on refresh
      git(b.root, "status", "--porcelain");
      expect((await b.call("git_commit", input, { elicitToken: token })).ok).toBe(true);
      expect(b.bridgeRequests).toHaveLength(1);
    } finally {
      b.cleanup();
    }
  });
});

describe("confirmationTargets: reset_vault_cache binds the rows it will clear", () => {
  const addChunk = (b: Booted, id: string) =>
    b.db
      .prepare(
        `INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at)
         VALUES (?, ?, 'a.md', '0', '[]', 'x', ?, 1, 1, 1)`,
      )
      .run(id, VAULT, `h-${id}`);
  const chunkCount = (b: Booted) =>
    (b.db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;

  it("rows added after the request are drift; the cache is NOT cleared", async () => {
    const b = boot();
    try {
      addChunk(b, "c1");
      const input = { vault: VAULT };
      const token = await raise(b, "reset_vault_cache", input);
      addChunk(b, "c2");
      expectDrift(await b.call("reset_vault_cache", input, { elicitToken: token }));
      expect(chunkCount(b)).toBe(2);
    } finally {
      b.cleanup();
    }
  });

  it("control: unchanged cache redeems and clears", async () => {
    const b = boot();
    try {
      addChunk(b, "c1");
      const input = { vault: VAULT };
      const token = await raise(b, "reset_vault_cache", input);
      expect((await b.call("reset_vault_cache", input, { elicitToken: token })).ok).toBe(true);
      expect(chunkCount(b)).toBe(0);
    } finally {
      b.cleanup();
    }
  });

  it("the confirmation flow's own event_log rows are not part of the binding", async () => {
    const b = boot();
    try {
      addChunk(b, "c1");
      const input = { vault: VAULT, include: { event_log: true } };
      const token = await raise(b, "reset_vault_cache", input);
      expect((await b.call("reset_vault_cache", input, { elicitToken: token })).ok).toBe(true);
    } finally {
      b.cleanup();
    }
  });
});

describe("confirmationTargets: delete_entity binds the entity row", () => {
  async function entity(b: Booted): Promise<string> {
    const r = await b.call("create_entity", { vault: VAULT, type: "tool", name: "linter" });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return (r.data as { entity_id: string }).entity_id;
  }
  const exists = (b: Booted, id: string) =>
    b.db.prepare("SELECT 1 FROM memory_entities WHERE id = ?").get(id) !== undefined;

  it("an entity edited after the request is drift; it is NOT deleted", async () => {
    const b = boot();
    try {
      const id = await entity(b);
      const input = { vault: VAULT, entity_id: id };
      const token = await raise(b, "delete_entity", input);
      const edit = await b.call("add_observation", {
        vault: VAULT,
        entity_id: id,
        observation: "added after the confirmation was requested",
      });
      expect(edit.ok).toBe(true);
      expectDrift(await b.call("delete_entity", input, { elicitToken: token }));
      expect(exists(b, id)).toBe(true);
    } finally {
      b.cleanup();
    }
  });

  it("a relation added after the request is drift", async () => {
    const b = boot();
    try {
      const id = await entity(b);
      const other = await b.call("create_entity", { vault: VAULT, type: "tool", name: "fmt" });
      if (!other.ok) throw new Error("setup");
      const otherId = (other.data as { entity_id: string }).entity_id;
      const input = { vault: VAULT, entity_id: id };
      const token = await raise(b, "delete_entity", input);
      const link = await b.call("link_entities", {
        vault: VAULT,
        source_id: otherId,
        target_id: id,
        relation_type: "uses",
      });
      expect(link.ok).toBe(true);
      expectDrift(await b.call("delete_entity", input, { elicitToken: token }));
      expect(exists(b, id)).toBe(true);
    } finally {
      b.cleanup();
    }
  });

  it("control: an untouched entity is deleted", async () => {
    const b = boot();
    try {
      const id = await entity(b);
      const input = { vault: VAULT, entity_id: id };
      const token = await raise(b, "delete_entity", input);
      expect((await b.call("delete_entity", input, { elicitToken: token })).ok).toBe(true);
      expect(exists(b, id)).toBe(false);
    } finally {
      b.cleanup();
    }
  });
});

describe("confirmationTargets: session_rerun binds the session's recorded trace", () => {
  function seed(b: Booted, ended: boolean): string {
    const id = genSessionId();
    const rel = cacheTraceRelPath(id);
    mkdirSync(dirname(join(b.cacheDir, rel)), { recursive: true });
    writeFileSync(join(b.cacheDir, rel), '{"tool":"read_note"}\n');
    insertSession(b.db, { id, vaultId: VAULT, caller: "alice", startedAt: 1000, tracePath: rel });
    if (ended) b.db.prepare("UPDATE workspace_sessions SET ended_at = 2000 WHERE id = ?").run(id);
    return rel;
  }

  it("a trace that grew after the request is drift; nothing is replayed", async () => {
    const b = boot();
    try {
      const rel = seed(b, true);
      const id = rel.replace(/^traces\//, "").replace(/\.jsonl$/, "");
      const input = { vault: VAULT, session_id: id };
      const token = await raise(b, "session_rerun", input);
      appendFileSync(join(b.cacheDir, rel), '{"tool":"delete_note"}\n');
      expectDrift(await b.call("session_rerun", input, { elicitToken: token }));
      expect(b.rerunCalls).toHaveLength(0);
    } finally {
      b.cleanup();
    }
  });

  it("control: an unchanged trace replays", async () => {
    const b = boot();
    try {
      const rel = seed(b, true);
      const id = rel.replace(/^traces\//, "").replace(/\.jsonl$/, "");
      const input = { vault: VAULT, session_id: id };
      const token = await raise(b, "session_rerun", input);
      expect((await b.call("session_rerun", input, { elicitToken: token })).ok).toBe(true);
      expect(b.rerunCalls).toHaveLength(1);
    } finally {
      b.cleanup();
    }
  });

  it("a session still open is bound on its row only: its trace grows with the calls around it", async () => {
    const b = boot();
    try {
      const rel = seed(b, false);
      const id = rel.replace(/^traces\//, "").replace(/\.jsonl$/, "");
      const input = { vault: VAULT, session_id: id };
      const token = await raise(b, "session_rerun", input);
      appendFileSync(join(b.cacheDir, rel), '{"tool":"read_note"}\n');
      expect((await b.call("session_rerun", input, { elicitToken: token })).ok).toBe(true);
    } finally {
      b.cleanup();
    }
  });

  it("ending the session after the request is drift even while the trace is open-ended", async () => {
    const b = boot();
    try {
      const rel = seed(b, false);
      const id = rel.replace(/^traces\//, "").replace(/\.jsonl$/, "");
      const input = { vault: VAULT, session_id: id };
      const token = await raise(b, "session_rerun", input);
      b.db.prepare("UPDATE workspace_sessions SET ended_at = 3000 WHERE id = ?").run(id);
      expectDrift(await b.call("session_rerun", input, { elicitToken: token }));
      expect(b.rerunCalls).toHaveLength(0);
    } finally {
      b.cleanup();
    }
  });
});

describe('confirmationTargets: "none" tools keep working on args_hash', () => {
  it("execute_command and trigger_quickadd redeem after unrelated vault changes", async () => {
    const b = boot({ "a.md": "x" });
    try {
      const cmd = { vault: VAULT, command_id: "editor:save-file" };
      const qa = { vault: VAULT, action_name: "Capture Idea" };
      const t1 = await raise(b, "execute_command", cmd);
      const t2 = await raise(b, "trigger_quickadd", qa);
      b.write("a.md", "changed");
      expect((await b.call("execute_command", cmd, { elicitToken: t1 })).ok).toBe(true);
      expect((await b.call("trigger_quickadd", qa, { elicitToken: t2 })).ok).toBe(true);
    } finally {
      b.cleanup();
    }
  });

  it("a token for a different args_hash still does not redeem", async () => {
    const b = boot();
    try {
      const token = await raise(b, "execute_command", {
        vault: VAULT,
        command_id: "editor:save-file",
      });
      const other = await b.call(
        "execute_command",
        { vault: VAULT, command_id: "editor:save-file", args: { x: 1 } },
        { elicitToken: token },
      );
      expect(other.ok).toBe(false);
      if (!other.ok) expect(other.error.code).toBe("elicit_required");
    } finally {
      b.cleanup();
    }
  });
});

describe("registration guard: a HITL-gated tool must declare what its confirmation is about", () => {
  const base = {
    domain: "notes" as const,
    description: "fake",
    inputSchema: z.object({ vault: z.string() }).strict(),
    handler: () => ({}),
  };
  const fresh = () => new ToolRegistry({ verifyElicit: elicitVerifier });
  const undeclared: Record<string, Partial<ToolDefinition>> = {
    "destructive: true": { destructive: true, requiredScopes: ["delete:notes"] },
    "an execute:* HITL-floor scope": { requiredScopes: ["execute:command"] },
    "conditionallyDestructive: true": {
      conditionallyDestructive: true,
      requiredScopes: ["write:notes"],
    },
    "an advertised elicit_token input": {
      requiredScopes: ["read:ocr"],
      inputSchema: z.object({ vault: z.string(), elicit_token: z.string().optional() }).strict(),
    },
  };

  for (const [why, extra] of Object.entries(undeclared)) {
    it(`throws at registration for ${why} with neither pathAcl nor confirmationTargets`, () => {
      expect(() =>
        fresh().register({ ...base, name: "fake_tool", ...extra } as ToolDefinition),
      ).toThrow(/fake_tool.*confirmationTargets/);
    });
  }

  it('accepts pathAcl, an explicit "none", or a targets function', () => {
    const gated = { ...base, destructive: true, requiredScopes: ["delete:notes"] };
    const r = fresh();
    r.register({ ...gated, name: "a", pathAcl: () => [] } as ToolDefinition);
    r.register({ ...gated, name: "b", confirmationTargets: "none" } as ToolDefinition);
    r.register({ ...gated, name: "c", confirmationTargets: () => null } as ToolDefinition);
    expect(r.list().map((d) => d.name)).toEqual(["a", "b", "c"]);
  });

  it("does not touch tools that are not HITL-gated", () => {
    expect(() =>
      fresh().register({
        ...base,
        name: "reader",
        requiredScopes: ["read:notes"],
      } as ToolDefinition),
    ).not.toThrow();
  });

  it("all 29 real HITL-gated tools declare a target set (and the floor is real)", () => {
    const gated = buildFullRegistry().list().filter(isHitlGated);
    expect(gated.length).toBeGreaterThanOrEqual(29);
    const missing = gated.filter((d) => !d.pathAcl && !d.confirmationTargets).map((d) => d.name);
    expect(missing).toEqual([]);
    const none = gated.filter((d) => d.confirmationTargets === "none").map((d) => d.name);
    expect(none.sort()).toEqual(["execute_command", "trigger_quickadd"]);
  });
});

describe("headless mint: a token with no raised request behind it", () => {
  const cfg = () => ServerConfigSchema.parse({ vaults: [{ id: VAULT, path: "/unused" }] });
  const cmdFor = (hash: string, tool: string): ElicitMintCmd => ({
    kind: "elicit-mint",
    hash,
    tool,
    caller: CALLER,
  });

  it("is refused: the CLI cannot rebuild the call's input from an args_hash", () => {
    const b = boot();
    try {
      const plan = planElicitMint(cfg(), cmdFor("0".repeat(32), "reset_vault_cache"));
      expect(() => mintElicitForRaisedRequest(b.db, plan)).toThrow(CliError);
      expect(() => mintElicitForRaisedRequest(b.db, plan)).toThrow(/no raised request/i);
    } finally {
      b.cleanup();
    }
  });

  it("mints for a raised request and inherits its fingerprint (state that moved is drift)", async () => {
    const b = boot();
    try {
      b.db
        .prepare(
          `INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at)
           VALUES ('c1', ?, 'a.md', '0', '[]', 'x', 'h1', 1, 1, 1)`,
        )
        .run(VAULT);
      const input = { vault: VAULT };
      const hash = hashOf(await b.call("reset_vault_cache", input));
      const token = mintElicitForRaisedRequest(
        b.db,
        planElicitMint(cfg(), cmdFor(hash, "reset_vault_cache")),
      );
      b.db
        .prepare(
          `INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at)
           VALUES ('c2', ?, 'a.md', '1', '[]', 'y', 'h2', 1, 1, 1)`,
        )
        .run(VAULT);
      expectDrift(await b.call("reset_vault_cache", input, { elicitToken: token }));
    } finally {
      b.cleanup();
    }
  });

  it('mints for a raised request of a "none" tool (nothing to bind, still a real request)', async () => {
    const b = boot();
    try {
      const cmd = { vault: VAULT, command_id: "editor:save-file" };
      const hash = hashOf(await b.call("execute_command", cmd));
      const token = mintElicitForRaisedRequest(
        b.db,
        planElicitMint(cfg(), cmdFor(hash, "execute_command")),
      );
      expect((await b.call("execute_command", cmd, { elicitToken: token })).ok).toBe(true);
    } finally {
      b.cleanup();
    }
  });

  it("the low-level mint stays permissive (library and test callers)", () => {
    const b = boot();
    try {
      const plan = planElicitMint(cfg(), cmdFor("1".repeat(32), "execute_command"));
      expect(typeof mintElicitAudited(b.db, plan)).toBe("string");
    } finally {
      b.cleanup();
    }
  });
});
