// THE-826 end-to-end: the CLI mint path (planElicitMint + mintElicitAudited) — not the raw
// issueElicitToken helper other suites reach for — actually satisfies the real HITL gate through
// registry.dispatch, and a token minted for a DIFFERENT operation, vault, or caller is refused by
// dispatch the same way verifyAndConsumeElicit refuses it directly (elicit-mint.test.ts covers
// that at the db layer; this file is the ticket's required end-to-end proof).
import {
  type ServerConfig,
  ServerConfigSchema,
  type ToolResult,
} from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { mintElicitAudited, planElicitMint } from "../src/cli/commands/elicit-mint";
import { makeTestVault } from "./m1-helpers";

function hashOf(r: ToolResult): string {
  if (r.ok) throw new Error("expected an error result");
  return String((r.error.details as { args_hash?: string }).args_hash);
}

const cfgFor = (vaults: Array<{ id: string; path: string }>, elicitTtlSeconds?: number) =>
  ServerConfigSchema.parse({
    vaults,
    ...(elicitTtlSeconds !== undefined ? { elicitTtlSeconds } : {}),
  }) as Pick<ServerConfig, "vaults" | "elicitTtlSeconds">;

// The test harness's default CallerContext.caller is "test" (m1-helpers.ts); the CLI mint's own
// default caller is "stdio" (server-runtime.ts's trusted-stdio context). Every call below
// overrides the harness to "stdio" so it is the MINT's real default being exercised end-to-end,
// not a coincidental match with the harness's usual fixture.
const STDIO = "stdio";

describe("THE-826: obsidian-tc elicit mint satisfies the real gate end-to-end", () => {
  it("a minted token satisfies move_note across a folder boundary", async () => {
    const v = makeTestVault({ files: { "note.md": "x" } });
    try {
      const input = { vault: "test", from: "note.md", to: "archive/note.md" };
      const need = await v.call("move_note", input, { caller: STDIO });
      expect(need.ok).toBe(false);
      if (need.ok) throw new Error("expected elicit_required");
      expect(need.error.code).toBe("elicit_required");

      const plan = planElicitMint(cfgFor([{ id: v.id, path: v.root }]), {
        kind: "elicit-mint",
        hash: hashOf(need),
        tool: "move_note",
        vault: v.id,
      });
      const token = mintElicitAudited(v.db, plan);

      const ok = await v.call("move_note", input, { elicitToken: token, caller: STDIO });
      expect(ok.ok).toBe(true);
      expect(v.exists("archive/note.md")).toBe(true);
      expect(v.exists("note.md")).toBe(false);
    } finally {
      v.cleanup();
    }
  });

  // move_note's own replay is unreachable once it succeeds (the source path is gone, so a second
  // call 404s before the gate is ever reached) — notes-tools.test.ts hits the identical wall and
  // proves single-use via write_note's overwrite instead, which stays redoable at the same path.
  // elicit-mint.test.ts already proves single-use directly against verifyAndConsumeElicit; this is
  // the dispatch-level version of the same claim, through the CLI mint path specifically.
  it("single-use: a token minted via the CLI path cannot be replayed through dispatch", async () => {
    const v = makeTestVault({ files: { "a.md": "old" } });
    try {
      const input = { vault: "test", path: "a.md", content: "new", mode: "overwrite" as const };
      const need = await v.call("write_note", input, { caller: STDIO });
      expect(need.ok).toBe(false);
      if (need.ok) throw new Error("expected elicit_required");

      const plan = planElicitMint(cfgFor([{ id: v.id, path: v.root }]), {
        kind: "elicit-mint",
        hash: hashOf(need),
        tool: "write_note",
        vault: v.id,
      });
      const token = mintElicitAudited(v.db, plan);

      const ok = await v.call("write_note", input, { elicitToken: token, caller: STDIO });
      expect(ok.ok).toBe(true);
      expect(v.read("a.md")).toBe("new");

      const replay = await v.call("write_note", input, { elicitToken: token, caller: STDIO });
      expect(replay.ok).toBe(false);
      if (!replay.ok) expect(replay.error.code).toBe("elicit_required");
    } finally {
      v.cleanup();
    }
  });

  it("a token minted for a DIFFERENT operation (different args, same tool) is refused", async () => {
    const v = makeTestVault({ files: { "note.md": "x", "other.md": "y" } });
    try {
      const realInput = { vault: "test", from: "note.md", to: "archive/note.md" };
      const decoyInput = { vault: "test", from: "other.md", to: "archive/other.md" };

      const need = await v.call("move_note", realInput, { caller: STDIO });
      expect(need.ok).toBe(false);
      const decoyNeed = await v.call("move_note", decoyInput, { caller: STDIO });
      expect(decoyNeed.ok).toBe(false);
      if (need.ok || decoyNeed.ok) throw new Error("expected both to need confirmation");

      // Mint bound to the DECOY's args_hash, not the real call's.
      const plan = planElicitMint(cfgFor([{ id: v.id, path: v.root }]), {
        kind: "elicit-mint",
        hash: hashOf(decoyNeed),
        tool: "move_note",
        vault: v.id,
      });
      const decoyToken = mintElicitAudited(v.db, plan);

      const attempt = await v.call("move_note", realInput, {
        elicitToken: decoyToken,
        caller: STDIO,
      });
      expect(attempt.ok).toBe(false);
      if (!attempt.ok) expect(attempt.error.code).toBe("elicit_required");
      expect(v.exists("note.md")).toBe(true); // nothing moved
    } finally {
      v.cleanup();
    }
  });

  it("a token minted for a DIFFERENT vault is refused", async () => {
    const v = makeTestVault({ files: { "note.md": "x" }, vaultId: "test" });
    try {
      const input = { vault: "test", from: "note.md", to: "archive/note.md" };
      const need = await v.call("move_note", input, { caller: STDIO });
      expect(need.ok).toBe(false);
      if (need.ok) throw new Error("expected elicit_required");

      const plan = planElicitMint(
        cfgFor([
          { id: "test", path: v.root },
          { id: "other-vault", path: "/nowhere" },
        ]),
        { kind: "elicit-mint", hash: hashOf(need), tool: "move_note", vault: "other-vault" },
      );
      const token = mintElicitAudited(v.db, plan);

      const attempt = await v.call("move_note", input, { elicitToken: token, caller: STDIO });
      expect(attempt.ok).toBe(false);
      if (!attempt.ok) expect(attempt.error.code).toBe("elicit_required");
      expect(v.exists("note.md")).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("a token minted for a DIFFERENT caller is refused (H-3)", async () => {
    const v = makeTestVault({ files: { "note.md": "x" } });
    try {
      const input = { vault: "test", from: "note.md", to: "archive/note.md" };
      const need = await v.call("move_note", input, { caller: STDIO });
      expect(need.ok).toBe(false);
      if (need.ok) throw new Error("expected elicit_required");

      const plan = planElicitMint(cfgFor([{ id: v.id, path: v.root }]), {
        kind: "elicit-mint",
        hash: hashOf(need),
        tool: "move_note",
        vault: v.id,
        caller: "someone-else",
      });
      const token = mintElicitAudited(v.db, plan);

      const attempt = await v.call("move_note", input, { elicitToken: token, caller: STDIO });
      expect(attempt.ok).toBe(false);
      if (!attempt.ok) expect(attempt.error.code).toBe("elicit_required");
      expect(v.exists("note.md")).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("expires after elicitTtlSeconds, checked through the real gate with an injected clock", async () => {
    const v = makeTestVault({ files: { "note.md": "x" } });
    try {
      const input = { vault: "test", from: "note.md", to: "archive/note.md" };
      let t = 1_000_000;
      const now = () => t;
      const need = await v.call("move_note", input, { caller: STDIO, now });
      expect(need.ok).toBe(false);
      if (need.ok) throw new Error("expected elicit_required");

      const plan = planElicitMint(cfgFor([{ id: v.id, path: v.root }], 60), {
        kind: "elicit-mint",
        hash: hashOf(need),
        tool: "move_note",
        vault: v.id,
      });
      const token = mintElicitAudited(v.db, plan, { now });
      t += 61_000; // one second past the 60s TTL

      const attempt = await v.call("move_note", input, { elicitToken: token, caller: STDIO, now });
      expect(attempt.ok).toBe(false);
      if (!attempt.ok) expect(attempt.error.code).toBe("elicit_required");
      expect(v.exists("note.md")).toBe(true);
    } finally {
      v.cleanup();
    }
  });
});
