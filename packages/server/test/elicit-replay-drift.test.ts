// A HITL confirmation is approval of a SPECIFIC state of the vault. args_hash binds a token to the
// tool and its arguments, but not to what those arguments pointed at when the request was raised:
// the human approved "overwrite/delete/move this note as it is now", and a token minted for that
// approval could be spent hours later against a note somebody had since rewritten. These tests raise
// a real request, mutate the underlying state, submit the ORIGINAL confirmation and assert the
// call is refused as `replay_drift` — never a generic failure and never a silent stale apply — on
// every route a confirmation can arrive by: a token minted directly, a token minted headlessly by
// `obsidian-tc elicit`, a 2026-era requestState, and the lean facade's call_capability.
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import {
  type ElicitMintCmd,
  mintElicitAudited,
  planElicitMint,
} from "../src/cli/commands/elicit-mint";
import { provisionCacheDb } from "../src/db/provision";
import { elicitVerifier, issueElicitToken } from "../src/elicit";
import { createElicitCodec } from "../src/elicit-request-state";
import { offerInputRequired } from "../src/mcp/elicit-form";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";
import { registerM1Tools } from "../src/tools/m1";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { rmTemp } from "./tmp";

const VAULT = "test";
const CALLER = "test";

function boot(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "obtc-drift-"));
  for (const [rel, content] of Object.entries(files)) writeFileSync(join(root, rel), content);
  const db = openMemoryDb();
  provisionCacheDb(db);
  const vaultRegistry = new VaultRegistry([{ id: VAULT, path: root }]);
  // rootResolver is what production wires (runtime/governance.ts); m1-helpers' registry omits it.
  const registry = new ToolRegistry({
    verifyElicit: elicitVerifier,
    rootResolver: (id) => (id === VAULT ? root : undefined),
  });
  registerM1Tools(registry, {
    vaultRegistry,
    version: "test",
    startedAt: 0,
    embeddings: { provider: "ollama", model: "nomic-embed-text" },
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
    db,
    registry,
    ctx,
    call: (name: string, input: Record<string, unknown>, over?: Partial<CallerContext>) =>
      registry.dispatch(name, input, ctx(over)),
    read: (rel: string) => readFileSync(join(root, rel), "utf8"),
    write: (rel: string, content: string) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    },
    cleanup: () => rmTemp(root),
  };
}

type Booted = ReturnType<typeof boot>;
type Result = Awaited<ReturnType<Booted["call"]>>;

function detailsOf(r: Result): { args_hash: string; state_fp?: unknown } {
  if (r.ok) throw new Error("expected an error result");
  return r.error.details as { args_hash: string; state_fp?: unknown };
}

function expectDrift(r: Result): void {
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.code).toBe("replay_drift");
  expect(r.error.retryable).toBe(false);
  expect(r.error.recovery).toMatch(/re-?request|no token|fresh confirmation/i);
}

function mint(b: Booted, tool: string, argsHash: string): string {
  return issueElicitToken(b.db, { vaultId: VAULT, toolName: tool, argsHash, caller: CALLER });
}

describe("replay_drift: tokens (dispatch-gated and handler-gated tools)", () => {
  it("delete_note: a note rewritten after the request was raised is NOT deleted", async () => {
    const b = boot({ "a.md": "original" });
    try {
      const input = { vault: VAULT, path: "a.md" };
      const need = await b.call("delete_note", input);
      expect(need.ok).toBe(false);
      const token = mint(b, "delete_note", detailsOf(need).args_hash);

      b.write("a.md", "rewritten by somebody else");
      const res = await b.call("delete_note", input, { elicitToken: token });
      expectDrift(res);
      expect(b.read("a.md")).toBe("rewritten by somebody else");
    } finally {
      b.cleanup();
    }
  });

  it("control: unchanged state still redeems the token", async () => {
    const b = boot({ "a.md": "original" });
    try {
      const input = { vault: VAULT, path: "a.md" };
      const need = await b.call("delete_note", input);
      const token = mint(b, "delete_note", detailsOf(need).args_hash);
      const res = await b.call("delete_note", input, { elicitToken: token });
      expect(res.ok).toBe(true);
    } finally {
      b.cleanup();
    }
  });

  it("write_note overwrite (handler-side gate): the stale overwrite does not land", async () => {
    const b = boot({ "a.md": "old" });
    try {
      const input = { vault: VAULT, path: "a.md", content: "new", mode: "overwrite" as const };
      const need = await b.call("write_note", input);
      expect(need.ok).toBe(false);
      const token = mint(b, "write_note", detailsOf(need).args_hash);

      b.write("a.md", "edited meanwhile");
      const res = await b.call("write_note", input, { elicitToken: token });
      expectDrift(res);
      expect(b.read("a.md")).toBe("edited meanwhile");
    } finally {
      b.cleanup();
    }
  });

  it("an mtime-only change (same bytes) is drift too", async () => {
    const b = boot({ "a.md": "same bytes" });
    try {
      const input = { vault: VAULT, path: "a.md", content: "new", mode: "overwrite" as const };
      const need = await b.call("write_note", input);
      const token = mint(b, "write_note", detailsOf(need).args_hash);

      const later = new Date(Date.now() + 60_000);
      utimesSync(join(b.root, "a.md"), later, later);
      expectDrift(await b.call("write_note", input, { elicitToken: token }));
      expect(b.read("a.md")).toBe("same bytes");
    } finally {
      b.cleanup();
    }
  });

  it("move_note overwrite onto an ABSENT destination: a note created there meanwhile is drift", async () => {
    const b = boot({ "a.md": "source" });
    try {
      const input = { vault: VAULT, from: "a.md", to: "archive/b.md", overwrite: true };
      const need = await b.call("move_note", input);
      expect(need.ok).toBe(false);
      if (!need.ok) expect(need.error.code).toBe("elicit_required");
      const token = mint(b, "move_note", detailsOf(need).args_hash);

      b.write("archive/b.md", "created after the request was raised");
      const res = await b.call("move_note", input, { elicitToken: token });
      expectDrift(res);
      expect(b.read("archive/b.md")).toBe("created after the request was raised");
      expect(b.read("a.md")).toBe("source");
    } finally {
      b.cleanup();
    }
  });

  it("a drifted token is burned: it cannot be retried once the state is restored", async () => {
    const b = boot({ "a.md": "original" });
    try {
      const input = { vault: VAULT, path: "a.md" };
      const need = await b.call("delete_note", input);
      const token = mint(b, "delete_note", detailsOf(need).args_hash);
      b.write("a.md", "changed");
      expectDrift(await b.call("delete_note", input, { elicitToken: token }));
      b.write("a.md", "original");
      const again = await b.call("delete_note", input, { elicitToken: token });
      expect(again.ok).toBe(false);
      if (!again.ok) expect(again.error.code).toBe("elicit_required");
    } finally {
      b.cleanup();
    }
  });

  it("a token minted with NO raised request behind it is unbound and still redeems", async () => {
    const b = boot({ "a.md": "original" });
    try {
      const input = { vault: VAULT, path: "a.md" };
      const { argsHash } = await import("../src/hash");
      const token = mint(b, "delete_note", argsHash("delete_note", input));
      b.write("a.md", "changed");
      const res = await b.call("delete_note", input, { elicitToken: token });
      expect(res.ok).toBe(true);
    } finally {
      b.cleanup();
    }
  });
});

describe("replay_drift: headless `obsidian-tc elicit` mint", () => {
  const cfg = (): Pick<ServerConfig, "vaults" | "elicitTtlSeconds"> =>
    ServerConfigSchema.parse({ vaults: [{ id: VAULT, path: "/unused" }] });
  const cmdFor = (hash: string, tool: string): ElicitMintCmd => ({
    kind: "elicit-mint",
    hash,
    tool,
    caller: CALLER,
  });

  it("a token the CLI minted for state that has since changed is refused as replay_drift", async () => {
    const b = boot({ "a.md": "original" });
    try {
      const input = { vault: VAULT, path: "a.md" };
      const need = await b.call("delete_note", input);
      const hash = detailsOf(need).args_hash;
      const token = mintElicitAudited(b.db, planElicitMint(cfg(), cmdFor(hash, "delete_note")));

      b.write("a.md", "changed after the operator's mint request");
      const res = await b.call("delete_note", input, { elicitToken: token });
      expectDrift(res);
      expect(b.read("a.md")).toBe("changed after the operator's mint request");
    } finally {
      b.cleanup();
    }
  });

  it("control: the CLI-minted token redeems when nothing changed", async () => {
    const b = boot({ "a.md": "original" });
    try {
      const input = { vault: VAULT, path: "a.md" };
      const need = await b.call("delete_note", input);
      const token = mintElicitAudited(
        b.db,
        planElicitMint(cfg(), cmdFor(detailsOf(need).args_hash, "delete_note")),
      );
      expect((await b.call("delete_note", input, { elicitToken: token })).ok).toBe(true);
    } finally {
      b.cleanup();
    }
  });
});

describe("replay_drift: 2026-era requestState (stdio form round trip / SDK shim)", () => {
  it("offerInputRequired binds the raise-time fingerprint into the signed state", async () => {
    const b = boot({ "a.md": "original" });
    try {
      const need = await b.call("delete_note", { vault: VAULT, path: "a.md" });
      if (need.ok) throw new Error("expected elicit_required");
      const codec = createElicitCodec("test-only-secret-not-a-real-credential-0123456789", 300);
      const offer = (await offerInputRequired(
        codec,
        "delete_note",
        need.error as never,
        { vaultId: VAULT, caller: CALLER },
        undefined,
      )) as unknown as { requestState: string };
      const state = await codec.verify(offer.requestState);
      expect(typeof state.stateFp).toBe("string");
      expect(state.stateFp).toBe(detailsOf(need).state_fp);
    } finally {
      b.cleanup();
    }
  });

  it("an approved state whose target drifted is refused (dispatch-gated and handler-gated)", async () => {
    const b = boot({ "a.md": "original", "c.md": "old" });
    try {
      const del = { vault: VAULT, path: "a.md" };
      const delNeed = await b.call("delete_note", del);
      const write = { vault: VAULT, path: "c.md", content: "new", mode: "overwrite" as const };
      const writeNeed = await b.call("write_note", write);
      const stateFor = (tool: string, r: Result) => ({
        tool,
        argsHash: detailsOf(r).args_hash,
        vaultId: VAULT,
        caller: CALLER,
        stateFp: detailsOf(r).state_fp as string,
      });

      b.write("a.md", "drifted");
      b.write("c.md", "drifted");
      expectDrift(
        await b.call("delete_note", del, { elicitState: stateFor("delete_note", delNeed) }),
      );
      expectDrift(
        await b.call("write_note", write, { elicitState: stateFor("write_note", writeNeed) }),
      );
      expect(b.read("a.md")).toBe("drifted");
      expect(b.read("c.md")).toBe("drifted");
    } finally {
      b.cleanup();
    }
  });

  it("control: an approved state with unchanged targets applies", async () => {
    const b = boot({ "a.md": "original" });
    try {
      const del = { vault: VAULT, path: "a.md" };
      const need = await b.call("delete_note", del);
      const res = await b.call("delete_note", del, {
        elicitState: {
          tool: "delete_note",
          argsHash: detailsOf(need).args_hash,
          vaultId: VAULT,
          caller: CALLER,
          stateFp: detailsOf(need).state_fp as string,
        },
      });
      expect(res.ok).toBe(true);
    } finally {
      b.cleanup();
    }
  });
});

describe("replay_drift: lean facade call_capability over the wire", () => {
  it("a token nested in call_capability's inner args is refused as replay_drift", async () => {
    const b = boot({ "a.md": "original" });
    try {
      const server = createMcpServer({
        name: "x",
        version: "0",
        registry: b.registry,
        context: () => b.ctx(),
        visibility: { grantedScopes: new Set(["*"]) },
        facadeMode: "triad",
      });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await server.connect(st);
      const client = new Client({ name: "t", version: "0" });
      await client.connect(ct);
      const structured = (r: unknown) =>
        (r as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};

      const args = { vault: VAULT, path: "a.md" };
      const need = await client.callTool({
        name: "call_capability",
        arguments: { name: "delete_note", args },
      });
      expect(structured(need).code).toBe("elicit_required");
      const hash = (structured(need).details as { args_hash: string }).args_hash;
      const token = mint(b, "delete_note", hash);

      b.write("a.md", "drifted");
      const res = await client.callTool({
        name: "call_capability",
        arguments: { name: "delete_note", args: { ...args, elicit_token: token } },
      });
      expect(res.isError).toBe(true);
      expect(structured(res).code).toBe("replay_drift");
      expect(JSON.stringify(res.content)).toMatch(/re-?request|no token|fresh confirmation/i);
      expect(b.read("a.md")).toBe("drifted");
      await client.close();
      await server.close();
    } finally {
      b.cleanup();
    }
  });
});
