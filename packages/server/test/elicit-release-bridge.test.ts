// A confirmed bridge call hands its request to the companion, which may run the action even when the
// response never arrives (a timeout, a 5xx with no envelope, an operation_timeout envelope). Dispatch
// cannot tell that apart from "nothing ran", so the confirmation stays spent: the same token must
// never fire the action a second time.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { type M4Vault, type M4VaultOptions, makeM4Vault } from "./m4-helpers";

const ALLOW_DELETE = () => ({ enabled: true, allowlist: ["app:delete-file"] });

let v: M4Vault | undefined;
afterEach(() => {
  v?.cleanup();
  v = undefined;
});

/** Raises, mints a token for the raise, redeems it twice. Counts the requests that reached `route`. */
async function redeemTwice(
  tool: string,
  input: Record<string, unknown>,
  route: string,
  opts: M4VaultOptions,
) {
  let fired = 0;
  const path = route.split(" ")[1]?.replace("/obsidian-tc/v1", "") ?? "";
  v = makeM4Vault({
    ...opts,
    onBridge: (info, root) => {
      if (new URL(info.url).pathname.endsWith(path)) fired += 1;
      opts.onBridge?.(info, root);
    },
  });
  const raise = await v.call(tool, input);
  expect(raise.ok ? "ok" : raise.error.code).toBe("elicit_required");
  const argsHash = (raise.ok ? undefined : raise.error.details?.args_hash) as string;
  const token = issueElicitToken(v.db, { vaultId: v.id, toolName: tool, argsHash, caller: "test" });
  const first = await v.call(tool, input, { elicitToken: token });
  const second = await v.call(tool, input, { elicitToken: token });
  const row = v.db.prepare("SELECT consumed_at FROM elicit_tokens WHERE token = ?").get(token) as {
    consumed_at: number | null;
  };
  return {
    first: first.ok ? "ok" : first.error.code,
    second: second.ok ? "ok" : second.error.code,
    fired,
    spent: row.consumed_at !== null,
  };
}

describe("a confirmed bridge call whose response is lost keeps its confirmation spent", () => {
  it("trigger_quickadd: a transport timeout after the request leaves the token spent and the action fired once", async () => {
    const r = await redeemTwice(
      "trigger_quickadd",
      { vault: "test", action_name: "Daily capture" },
      "POST /obsidian-tc/v1/quickadd/trigger",
      {
        installed: ["quickadd"],
        routes: { "POST /obsidian-tc/v1/quickadd/trigger": { abort: true } },
      },
    );
    expect(r.first).toBe("plugin_unreachable");
    expect(r).toMatchObject({ second: "elicit_required", fired: 1, spent: true });
  });

  it("trigger_quickadd: a 502 with no envelope after the request leaves the token spent and the action fired once", async () => {
    const r = await redeemTwice(
      "trigger_quickadd",
      { vault: "test", action_name: "Daily capture" },
      "POST /obsidian-tc/v1/quickadd/trigger",
      {
        installed: ["quickadd"],
        routes: { "POST /obsidian-tc/v1/quickadd/trigger": { status: 502, body: "bad gateway" } },
      },
    );
    expect(r.first).not.toBe("ok");
    expect(r).toMatchObject({ second: "elicit_required", fired: 1, spent: true });
  });

  it("execute_command: an operation_timeout envelope leaves the token spent and the command fired once", async () => {
    const r = await redeemTwice(
      "execute_command",
      { vault: "test", command_id: "app:delete-file" },
      "POST /obsidian-tc/v1/commands/execute",
      {
        commandPolicy: ALLOW_DELETE,
        routes: {
          "POST /obsidian-tc/v1/commands/execute": {
            status: 500,
            body: { ok: false, code: "operation_timeout", message: "command did not finish" },
          },
        },
      },
    );
    expect(r.first).toBe("operation_timeout");
    expect(r).toMatchObject({ second: "elicit_required", fired: 1, spent: true });
  });

  it("execute_template: a state-bound token whose template moved its output runs the user JS once", async () => {
    let runs = 0;
    const r = await redeemTwice(
      "execute_template",
      { vault: "test", template: "templates/t.md", target: "notes/out" },
      "POST /obsidian-tc/v1/templater/execute",
      {
        installed: ["templater"],
        bindState: true,
        files: { "templates/t.md": "<% tp.file.move('/inbox/' + Date.now()) %>" },
        routes: { "POST /obsidian-tc/v1/templater/execute": { abort: true } },
        // The template's own JS relocates its output, then the response is lost.
        onBridge: (info, root) => {
          if (!info.url.endsWith("/templater/execute")) return;
          runs += 1;
          const abs = join(root, `inbox/run-${runs}.md`);
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, "created by the template");
        },
      },
    );
    expect(r.first).toBe("plugin_unreachable");
    expect(r).toMatchObject({ second: "elicit_required", spent: true });
    expect(runs).toBe(1);
  });
});
