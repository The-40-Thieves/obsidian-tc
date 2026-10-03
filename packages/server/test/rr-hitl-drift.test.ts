// Release-review findings on the HITL drift binding (state fingerprint, abort windows, probe
// failure, request retention). Each case quotes the reviewer's repro. The ledger selects them by
// the RR-<id> prefix in the test name.
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FolderAcl } from "../src/acl";
import {
  CapabilityCache,
  createBridgeClient,
  type FakeRequestInfo,
  fakeBridgeTransport,
} from "../src/bridge";
import { type CliCommand, parseCliArgs } from "../src/cli/args";
import {
  type ElicitMintCmd,
  mintElicitForRaisedRequest,
  planElicitMint,
} from "../src/cli/commands/elicit-mint";
import { provisionCacheDb } from "../src/db/provision";
import {
  elicitVerifier,
  hasRaisedElicitRequest,
  issueElicitToken,
  recordElicitRequest,
} from "../src/elicit";
import { mintCommandFromDetails } from "../src/mcp/elicit-command";
import { type CallerContext, type ToolDefinition, ToolRegistry } from "../src/mcp/registry";
import type { ProvenanceSink } from "../src/mcp/registry/types";
import { registerM1Tools } from "../src/tools/m1";
import { registerM4Tools } from "../src/tools/m4";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const VAULT = "test";
const CALLER = "test";
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    env: GIT_ENV,
    stdio: "pipe",
  }).toString();

function boot(files: Record<string, string> = {}) {
  const root = makeTempDir("obtc-rr-drift-");
  const write = (rel: string, content: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  };
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  const db = openMemoryDb();
  provisionCacheDb(db);
  const vaultRegistry = new VaultRegistry([{ id: VAULT, name: VAULT, path: root }]);
  const acl = new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] });
  const bridgeRequests: FakeRequestInfo[] = [];
  const capabilities = new CapabilityCache();
  capabilities.set(VAULT, { companion: "reachable", plugins: { git: { installed: true } } });
  const client = createBridgeClient({
    baseUrl: "http://127.0.0.1:27124",
    apiKey: "k",
    fetchFn: fakeBridgeTransport({
      routes: { "POST /obsidian-tc/v1/git/commit": { body: { ok: true, result: { sha: "abc" } } } },
      onRequest: (i) => bridgeRequests.push(i),
    }),
  });
  const registry = new ToolRegistry({
    verifyElicit: elicitVerifier,
    rootResolver: (id) => (id === VAULT ? root : undefined),
    aclResolver: () => acl,
  });
  registerM1Tools(registry, {
    vaultRegistry,
    version: "test",
    startedAt: 0,
    embeddings: { provider: "none", model: "none" },
  });
  registerM4Tools(registry, { vaultRegistry, capabilities, bridgeFor: () => client });
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
    db,
    registry,
    bridgeRequests,
    write,
    has: (rel: string) => existsSync(join(root, rel)),
    call: (name: string, input: Record<string, unknown>, over?: Partial<CallerContext>) =>
      registry.dispatch(name, input, ctx(over)),
    cleanup: () => rmTemp(root),
  };
}
type Booted = ReturnType<typeof boot>;
type Result = Awaited<ReturnType<Booted["call"]>>;

const errOf = (r: Result) => {
  if (r.ok) throw new Error("expected an error result");
  return r.error;
};

/** The operator's side: run the mint command text an `elicit_required` error rendered, exactly as
 *  typed (parsed by the real CLI argument parser, then minted like `obsidian-tc elicit`). */
function mintFromCommand(b: Booted, details: Record<string, unknown>): string {
  const command = mintCommandFromDetails(details);
  if (command === undefined) throw new Error("no mint command");
  const parsed: CliCommand = parseCliArgs(command.split(" ").slice(1));
  if (parsed.kind !== "elicit-mint") throw new Error(`parsed as ${parsed.kind}`);
  const cfg = ServerConfigSchema.parse({ vaults: [{ id: VAULT, path: b.root }] });
  return mintElicitForRaisedRequest(b.db, planElicitMint(cfg, parsed as ElicitMintCmd));
}

describe("RR-M1 repeating a blocked call must not rebind an earlier mint command to newer state", () => {
  it("RR-M1 reviewer repro: request deletion of a.md=A, change to B, repeat the request, mint the ORIGINAL command -> replay_drift, B survives", async () => {
    const b = boot({ "a.md": "A" });
    try {
      const input = { vault: VAULT, path: "a.md" };
      const first = errOf(await b.call("delete_note", input));
      expect(first.code).toBe("elicit_required");
      const original = first.details as Record<string, unknown>;

      b.write("a.md", "B");
      const second = errOf(await b.call("delete_note", input));
      expect(second.code).toBe("elicit_required");
      expect((second.details as { state_fp: string }).state_fp).not.toBe(original.state_fp);

      const token = mintFromCommand(b, original);
      // The headless mint binds the ORIGINAL request's state (A), not the newest row's (B).
      const bound = b.db
        .prepare("SELECT state_fp FROM elicit_tokens WHERE token = ?")
        .get(token) as {
        state_fp: string;
      };
      expect(bound.state_fp).toBe(original.state_fp);
      const r = await b.call("delete_note", input, { elicitToken: token });
      expect(errOf(r).code).toBe("replay_drift");
      expect(b.has("a.md")).toBe(true);
    } finally {
      b.cleanup();
    }
  });

  it("RR-M1 control: the command from the NEWEST request approves the newest state", async () => {
    const b = boot({ "a.md": "A" });
    try {
      const input = { vault: VAULT, path: "a.md" };
      await b.call("delete_note", input);
      b.write("a.md", "B");
      const second = errOf(await b.call("delete_note", input));
      const token = mintFromCommand(b, second.details as Record<string, unknown>);
      expect((await b.call("delete_note", input, { elicitToken: token })).ok).toBe(true);
      expect(b.has("a.md")).toBe(false);
    } finally {
      b.cleanup();
    }
  });
});

describe("RR-M2 a cancelled call never reaches its handler", () => {
  const writeTool = (effect: { applied: number }, destructive = false): ToolDefinition =>
    ({
      name: "rr_write",
      description: "test-only mutating tool",
      inputSchema: z.object({}).strict(),
      requiredScopes: ["write:notes"],
      ...(destructive ? { destructive: true, confirmationTargets: "none" } : {}),
      handler: () => {
        effect.applied += 1;
        return { ok: true };
      },
    }) as unknown as ToolDefinition;
  const baseCtx = (signal: AbortSignal): CallerContext => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    return {
      caller: CALLER,
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: VAULT,
      db,
      signal,
    };
  };

  it("RR-M2 reviewer repro: abort the signal inside default-on provenance.begin() -> aborted, handler never called", async () => {
    const controller = new AbortController();
    const effect = { applied: 0 };
    const provenance: ProvenanceSink = {
      begin: async () => {
        controller.abort();
        return {};
      },
      commit: async () => {},
    };
    const registry = new ToolRegistry({ provenance });
    registry.register(writeTool(effect));
    const r = await registry.dispatch("rr_write", {}, baseCtx(controller.signal));
    expect(controller.signal.aborted).toBe(true);
    expect(errOf(r).code).toBe("aborted");
    expect(effect.applied).toBe(0);
  });

  it("RR-M2 abort during the async throttle check: no confirmation token is spent and the handler is not called", async () => {
    const controller = new AbortController();
    const effect = { applied: 0 };
    let verifyCalls = 0;
    const registry = new ToolRegistry({
      rateLimiter: {
        check: async () => {
          controller.abort();
          return {
            ok: true,
            scopeClass: "write",
            retryAfterSeconds: 0,
            currentBurst: 0,
            currentRate: 0,
          };
        },
      } as never,
      verifyElicit: () => {
        verifyCalls += 1;
        return true;
      },
    });
    registry.register(writeTool(effect, true));
    const r = await registry.dispatch(
      "rr_write",
      {},
      { ...baseCtx(controller.signal), elicitToken: "tok" },
    );
    expect(errOf(r).code).toBe("aborted");
    expect(verifyCalls).toBe(0);
    expect(effect.applied).toBe(0);
  });
});

describe("RR-M3 a throwing fingerprint probe fails closed", () => {
  it("RR-M3 reviewer repro: hard-linked note -> delete_note is refused (acl_denied) and records no unbound request, so no mint can approve it", async () => {
    const b = boot({ "note.md": "original" });
    try {
      linkSync(join(b.root, "note.md"), join(b.root, "alias.md"));
      const input = { vault: VAULT, path: "note.md" };
      const first = await b.call("delete_note", input);
      expect(errOf(first).code).toBe("acl_denied");

      // "drop the extra link, edit the note, redeem the confirmation": nothing can be minted.
      unlinkSync(join(b.root, "alias.md"));
      b.write("note.md", "edited after the request");
      const again = errOf(await b.call("delete_note", input));
      expect(again.code).toBe("elicit_required");
      // ...and the request that IS raised now is bound to the edited state it was raised against.
      expect((again.details as { state_fp?: string }).state_fp).toEqual(expect.any(String));
    } finally {
      b.cleanup();
    }
  });

  it("RR-M3 the refused hard-link call leaves no elicit_requests row to mint against", async () => {
    const b = boot({ "note.md": "original" });
    try {
      linkSync(join(b.root, "note.md"), join(b.root, "alias.md"));
      await b.call("delete_note", { vault: VAULT, path: "note.md" });
      const rows = b.db.prepare("SELECT count(*) AS n FROM elicit_requests").get() as { n: number };
      expect(rows.n).toBe(0);
    } finally {
      b.cleanup();
    }
  });

  it("RR-M3 git_commit with an unreadable HEAD never raises an UNBOUND request", async () => {
    const b = boot();
    try {
      git(b.root, "init", "-q", "-b", "main");
      b.write("a.md", "one");
      git(b.root, "add", "a.md");
      git(b.root, "commit", "-q", "-m", "first");
      rmSync(join(b.root, ".git", "HEAD"));
      const e = errOf(await b.call("git_commit", { vault: VAULT, message: "snapshot" }));
      expect(e.code).not.toBe("elicit_required");
      expect(b.bridgeRequests).toHaveLength(0);
    } finally {
      b.cleanup();
    }
  });
});

describe("RR-L1 request retention is enforced on lookup", () => {
  const H = 60 * 60 * 1000;
  it("RR-L1 reviewer repro: record one request, raise nothing else, mint 25 hours later -> not found", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const t0 = 1_700_000_000_000;
    recordElicitRequest(db, {
      vaultId: VAULT,
      argsHash: "h1",
      caller: CALLER,
      stateFp: "fp",
      now: () => t0,
    });
    expect(hasRaisedElicitRequest(db, VAULT, "h1", CALLER, () => t0 + 23 * H)).toBe(true);
    expect(hasRaisedElicitRequest(db, VAULT, "h1", CALLER, () => t0 + 25 * H)).toBe(false);
    const stale = issueElicitToken(db, {
      vaultId: VAULT,
      toolName: "t",
      argsHash: "h1",
      caller: CALLER,
      now: () => t0 + 25 * H,
    });
    const row = db.prepare("SELECT state_fp FROM elicit_tokens WHERE token = ?").get(stale) as {
      state_fp: string | null;
    };
    expect(row.state_fp).toBeNull();
  });
});
