// A confirmation the handler consumes itself (requireConfirmation, vault/hitl.ts) follows the release rule
// dispatch applies to a dispatch-side one (elicit-release-on-refusal.test.ts): a call its own write gate
// refused before any write hands the token back, with the bound state kept. Every other failure keeps it spent.
import { join } from "node:path";
import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { issueElicitToken } from "../src/elicit";
import type { CallerContext, ToolDefinition, ToolRegistry } from "../src/mcp/registry";
import { requireConfirmation } from "../src/vault/hitl";
import { gateNoteWrite } from "../src/vault/write-gate";
import { STATUS_RULES } from "./conventions-helpers";
import { type M6Vault, makeM6Vault } from "./m6-helpers";

const MEETING = "meetings/SCHEMA.md";
const VAULT = "test";
const CALLER = "test";
const BAD = "---\nstatus: bogus\n---\nold\n";
const GOOD = "---\ntype: meeting\nstatus: draft\n---\nbody\n";
const BLOCKED = "---\nstatus: bogus\n---\nnew\n";
const FILES = { [MEETING]: STATUS_RULES("block"), "lax/SCHEMA.md": STATUS_RULES("warn") };
const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? "ok" : r.error?.code);

interface Probe {
  applied: number;
}

/** A test-only handler that confirms itself, then writes one note through the write gate. `mode` picks
 *  what happens after the confirmation: "commit" signals an effect and then fails, "acl" fails before any write. */
function registerRcWrite(reg: ToolRegistry, probe: Probe, root: () => string): void {
  reg.register({
    name: "rc_write",
    description: "test-only handler-side confirmation",
    inputSchema: z
      .object({
        text: z.string(),
        mode: z.string().optional(),
        delay: z.number().optional(),
      })
      .strict(),
    outputSchema: z.object({ ok: z.boolean(), conventions: z.unknown().optional() }).strict(),
    requiredScopes: ["write:notes"],
    pathAcl: () => [{ op: "write", path: "meetings/t.md" }],
    handler: async (input: { text: string; mode?: string; delay?: number }, ctx: CallerContext) => {
      requireConfirmation(ctx, "rc_write", input, true);
      if (input.delay) await new Promise((r) => setTimeout(r, input.delay));
      if (input.mode === "commit") {
        ctx.markEffectCommitted?.();
        throw new ObsidianTcError("internal", "failed after the effect");
      }
      if (input.mode === "acl")
        throw new ObsidianTcError("validation_error", "refused after confirm");
      gateNoteWrite(join(root(), "meetings/t.md"), input.text);
      probe.applied += 1;
      return { ok: true };
    },
  } as unknown as ToolDefinition);
}

function vault(probe: Probe = { applied: 0 }): M6Vault {
  return makeM6Vault({
    conventions: true,
    files: FILES,
    register: (reg, deps) => {
      registerRcWrite(reg, probe, () => deps.vaultRegistry.resolve(VAULT).root);
    },
  });
}

/** Raises elicit_required for `name` and `input`, mints the token for it, and redeems it once. */
async function confirm(v: M6Vault, name: string, input: Record<string, unknown>) {
  const first = await v.call(name, input);
  expect(code(first)).toBe("elicit_required");
  const argsHash = (first.ok ? undefined : first.error.details?.args_hash) as string;
  const token = issueElicitToken(v.db, { vaultId: v.id, toolName: name, argsHash, caller: CALLER });
  const refused = await v.call(name, input, { elicitToken: token });
  return { token, refused };
}

const consumedAt = (v: M6Vault, token: string) =>
  (
    v.db.prepare("SELECT consumed_at FROM elicit_tokens WHERE token = ?").get(token) as {
      consumed_at: number | null;
    }
  ).consumed_at;

const releasedEvents = (v: M6Vault) =>
  v.db.prepare("SELECT tool_name, status FROM event_log WHERE event_type = 'hitl_released'").all();

describe("move_note across folders: a destination refused before confirmation is never spent", () => {
  // move_note judges its destination in a preflight that runs before requireConfirmation, so a
  // convention_blocked refusal here happens before the token is spent. This guards that ordering.
  it("a confirmed move refused by convention_blocked leaves the token unspent: the same token and args succeed after the fix", async () => {
    const v = vault();
    try {
      v.write("lax/a.md", BAD);
      v.write(MEETING, STATUS_RULES("warn"));
      const input = { vault: VAULT, from: "lax/a.md", to: "meetings/a.md" };
      const first = await v.call("move_note", input);
      expect(code(first)).toBe("elicit_required");
      const argsHash = (first.ok ? undefined : first.error.details?.args_hash) as string;
      const token = issueElicitToken(v.db, {
        vaultId: v.id,
        toolName: "move_note",
        argsHash,
        caller: CALLER,
      });
      v.write(MEETING, STATUS_RULES("block"));
      expect(code(await v.call("move_note", input, { elicitToken: token }))).toBe(
        "convention_blocked",
      );
      expect(consumedAt(v, token)).toBeNull();
      v.write(MEETING, STATUS_RULES("warn"));
      expect(code(await v.call("move_note", input, { elicitToken: token }))).toBe("ok");
      expect(v.read("meetings/a.md")).toBe(BAD);
    } finally {
      v.cleanup();
    }
  });
});

describe("write_note overwrite: a destination refused before confirmation is never spent", () => {
  // write_note also runs its write-gate preflight before requireConfirmation, so the refusal happens
  // before the token is spent. This guards that ordering.
  it("a confirmed overwrite refused by convention_blocked leaves the token unspent: the same token and args succeed after the fix", async () => {
    const v = vault();
    try {
      v.write("meetings/a.md", GOOD);
      v.write(MEETING, STATUS_RULES("warn"));
      const input = { vault: VAULT, path: "meetings/a.md", content: BAD, mode: "overwrite" };
      const first = await v.call("write_note", input);
      expect(code(first)).toBe("elicit_required");
      const argsHash = (first.ok ? undefined : first.error.details?.args_hash) as string;
      const token = issueElicitToken(v.db, {
        vaultId: v.id,
        toolName: "write_note",
        argsHash,
        caller: CALLER,
      });
      v.write(MEETING, STATUS_RULES("block"));
      expect(code(await v.call("write_note", input, { elicitToken: token }))).toBe(
        "convention_blocked",
      );
      expect(consumedAt(v, token)).toBeNull();
      v.write(MEETING, STATUS_RULES("warn"));
      expect(code(await v.call("write_note", input, { elicitToken: token }))).toBe("ok");
      expect(v.read("meetings/a.md")).toBe(BAD);
    } finally {
      v.cleanup();
    }
  });
});

describe("a handler-side confirmation refused by the write gate after confirmation", () => {
  it("a convention_blocked from the write gate releases the token: the same token and args succeed after the fix", async () => {
    const probe = { applied: 0 };
    const v = vault(probe);
    try {
      const input = { text: BLOCKED };
      const { token, refused } = await confirm(v, "rc_write", input);
      expect(code(refused)).toBe("convention_blocked");
      expect(consumedAt(v, token)).toBeNull();
      v.write(MEETING, STATUS_RULES("warn"));
      expect(code(await v.call("rc_write", input, { elicitToken: token }))).toBe("ok");
      expect(probe.applied).toBe(1);
    } finally {
      v.cleanup();
    }
  });

  it("a released token whose bound state then changes is refused as replay_drift", async () => {
    const v = vault();
    try {
      const input = { text: BLOCKED };
      const { token, refused } = await confirm(v, "rc_write", input);
      expect(code(refused)).toBe("convention_blocked");
      v.write(MEETING, STATUS_RULES("warn"));
      v.write("meetings/t.md", GOOD);
      expect(code(await v.call("rc_write", input, { elicitToken: token }))).toBe("replay_drift");
      expect(v.read("meetings/t.md")).toBe(GOOD);
    } finally {
      v.cleanup();
    }
  });

  it("the release records one hitl_released event", async () => {
    const v = vault();
    try {
      await confirm(v, "rc_write", { text: BLOCKED });
      expect(releasedEvents(v)).toEqual([{ tool_name: "rc_write", status: "skipped" }]);
    } finally {
      v.cleanup();
    }
  });

  it("two concurrent calls with one token apply the effect at most once", async () => {
    const probe = { applied: 0 };
    const v = vault(probe);
    try {
      const input = { text: BLOCKED, delay: 30 };
      const first = await v.call("rc_write", input);
      const argsHash = (first.ok ? undefined : first.error.details?.args_hash) as string;
      const token = issueElicitToken(v.db, {
        vaultId: v.id,
        toolName: "rc_write",
        argsHash,
        caller: CALLER,
      });
      const [x, y] = await Promise.all([
        v.call("rc_write", input, { elicitToken: token }),
        v.call("rc_write", input, { elicitToken: token }),
      ]);
      expect([code(x), code(y)].sort()).toEqual(["convention_blocked", "elicit_required"]);
      v.write(MEETING, STATUS_RULES("warn"));
      expect(code(await v.call("rc_write", input, { elicitToken: token }))).toBe("ok");
      expect(code(await v.call("rc_write", input, { elicitToken: token }))).toBe("elicit_required");
      expect(probe.applied).toBe(1);
    } finally {
      v.cleanup();
    }
  });
});

describe("a handler-side confirmation spent by a call that is not a pre-effect refusal", () => {
  it("a handler that commits an effect and then fails keeps its token spent", async () => {
    const probe = { applied: 0 };
    const v = vault(probe);
    try {
      const input = { text: "fine", mode: "commit" };
      const { token, refused } = await confirm(v, "rc_write", input);
      expect(code(refused)).toBe("internal");
      expect(consumedAt(v, token)).not.toBeNull();
      expect(code(await v.call("rc_write", input, { elicitToken: token }))).toBe("elicit_required");
      expect(probe.applied).toBe(0);
    } finally {
      v.cleanup();
    }
  });

  it("a refusal the handler raises after confirmation, not from the write gate, keeps the token spent", async () => {
    const probe = { applied: 0 };
    const v = vault(probe);
    try {
      const input = { text: "fine", mode: "acl" };
      const { token, refused } = await confirm(v, "rc_write", input);
      expect(code(refused)).toBe("validation_error");
      expect(consumedAt(v, token)).not.toBeNull();
      expect(code(await v.call("rc_write", input, { elicitToken: token }))).toBe("elicit_required");
      expect(probe.applied).toBe(0);
    } finally {
      v.cleanup();
    }
  });
});
