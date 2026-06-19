import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { makeM3Vault } from "./m3-helpers";

function hashOf(r: ToolResult): string {
  if (r.ok) throw new Error("expected an error result");
  return String((r.error.details as { args_hash?: string }).args_hash);
}
function mint(v: ReturnType<typeof makeM3Vault>, toolName: string, argsHash: string): string {
  return issueElicitToken(v.db, { vaultId: v.id, toolName, argsHash, caller: "test" });
}

describe("Domain 11: Workspaces", () => {
  it("save_workspace creates the file, list_workspaces reports it active, and audits", async () => {
    const v = makeM3Vault();
    try {
      const s = await v.call("save_workspace", {
        vault: "test",
        name: "Work",
        layout: { main: { id: "x" } },
        set_active: true,
      });
      expect(s.ok).toBe(true);
      if (s.ok) expect((s.data as { created: boolean }).created).toBe(true);
      expect(v.exists(".obsidian/workspaces.json")).toBe(true);

      const l = await v.call("list_workspaces", { vault: "test" });
      if (l.ok) {
        const d = l.data as { workspaces: string[]; active: string | null; count: number };
        expect(d.workspaces).toEqual(["Work"]);
        expect(d.active).toBe("Work");
        expect(d.count).toBe(1);
      }
      expect(v.events().some((e) => e.tool_name === "save_workspace" && e.status === "ok")).toBe(
        true,
      );
    } finally {
      v.cleanup();
    }
  });

  it("open_workspace marks a saved workspace active and returns its layout", async () => {
    const v = makeM3Vault();
    try {
      await v.call("save_workspace", {
        vault: "test",
        name: "Work",
        layout: { a: 1 },
        set_active: true,
      });
      await v.call("save_workspace", { vault: "test", name: "Personal", layout: { b: 2 } });
      const o = await v.call("open_workspace", { vault: "test", name: "Personal" });
      expect(o.ok).toBe(true);
      if (o.ok) {
        const d = o.data as { active: string; layout: { b?: number } };
        expect(d.active).toBe("Personal");
        expect(d.layout.b).toBe(2);
      }
      const l = await v.call("list_workspaces", { vault: "test" });
      if (l.ok) expect((l.data as { active: string }).active).toBe("Personal");
    } finally {
      v.cleanup();
    }
  });

  it("open_workspace on an unknown name is note_not_found", async () => {
    const v = makeM3Vault();
    try {
      const o = await v.call("open_workspace", { vault: "test", name: "ghost" });
      expect(o.ok).toBe(false);
      if (!o.ok) expect(o.error.code).toBe("note_not_found");
    } finally {
      v.cleanup();
    }
  });

  it("save_workspace refuses to clobber without overwrite, then runs the HITL cycle", async () => {
    const v = makeM3Vault();
    try {
      await v.call("save_workspace", { vault: "test", name: "Work", layout: { a: 1 } });
      const clob = await v.call("save_workspace", {
        vault: "test",
        name: "Work",
        layout: { a: 2 },
      });
      expect(clob.ok).toBe(false);
      if (!clob.ok) expect(clob.error.code).toBe("note_exists");

      const input = { vault: "test", name: "Work", layout: { a: 3 }, overwrite: true };
      const need = await v.call("save_workspace", input);
      expect(need.ok).toBe(false);
      if (!need.ok) expect(need.error.code).toBe("elicit_required");
      const ok = await v.call("save_workspace", input, {
        elicitToken: mint(v, "save_workspace", hashOf(need)),
      });
      expect(ok.ok).toBe(true);
      if (ok.ok) expect((ok.data as { created: boolean }).created).toBe(false);
    } finally {
      v.cleanup();
    }
  });

  it("save_workspace preserves other workspaces and unknown top-level keys", async () => {
    const v = makeM3Vault({
      files: {
        ".obsidian/workspaces.json": JSON.stringify(
          { workspaces: { A: { x: 1 } }, active: "A", custom: true },
          null,
          "\t",
        ),
      },
    });
    try {
      const s = await v.call("save_workspace", { vault: "test", name: "B", layout: { y: 2 } });
      expect(s.ok).toBe(true);
      const raw = JSON.parse(v.read(".obsidian/workspaces.json")) as {
        custom?: boolean;
        active?: string;
        workspaces: Record<string, unknown>;
      };
      expect(raw.custom).toBe(true);
      expect(raw.active).toBe("A"); // set_active defaulted false
      expect(Object.keys(raw.workspaces).sort()).toEqual(["A", "B"]);
    } finally {
      v.cleanup();
    }
  });

  it("a save outside the write whitelist is acl_denied", async () => {
    const v = makeM3Vault({ acl: { writePaths: ["allowed/**"] } });
    try {
      const denied = await v.call("save_workspace", {
        vault: "test",
        name: "Work",
        layout: { a: 1 },
      });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe("acl_denied");
    } finally {
      v.cleanup();
    }
  });
});
