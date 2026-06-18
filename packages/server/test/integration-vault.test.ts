// Live-vault integration test. Unlike the per-domain suites, this drives a single
// realistic lifecycle end-to-end through registry.dispatch against a real on-disk
// temp vault, and asserts both the filesystem state and the audit (event_log)
// rows the pipeline writes — including the HITL elicit cycle and a folder-ACL
// denial. It is the proof that the M1 tool surface composes through the full M0
// pipeline (validate → auth → scope/ACL → HITL → execute → audit).
import type { ToolResult } from "@obsidian-tc/shared";
import { describe, expect, it } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { makeTestVault } from "./m1-helpers";

function hashOf(r: ToolResult): string {
  if (r.ok) throw new Error("expected an error result");
  return String((r.error.details as { args_hash?: string }).args_hash);
}
function mint(v: ReturnType<typeof makeTestVault>, toolName: string, argsHash: string): string {
  return issueElicitToken(v.db, { vaultId: v.id, toolName, argsHash, caller: "test" });
}

describe("M1 live-vault integration (through dispatch)", () => {
  it("drives create → frontmatter → tag → backlinks → move → delete on a real temp vault", async () => {
    const v = makeTestVault();
    try {
      // create a project note that links to a sibling, plus the sibling itself
      const created = await v.call("write_note", {
        vault: "test",
        path: "projects/alpha.md",
        content: "---\ntitle: Alpha\nstatus: draft\n---\nSee [[beta]].\n",
      });
      expect(created.ok).toBe(true);
      await v.call("write_note", { vault: "test", path: "beta.md", content: "# Beta\n" });
      expect(v.exists("projects/alpha.md")).toBe(true);
      expect(v.exists("beta.md")).toBe(true);

      // frontmatter read + mutate
      const fm = await v.call("read_frontmatter", { vault: "test", path: "projects/alpha.md" });
      if (fm.ok)
        expect((fm.data as { frontmatter: Record<string, unknown> }).frontmatter).toMatchObject({
          title: "Alpha",
          status: "draft",
        });
      await v.call("update_frontmatter", {
        vault: "test",
        path: "projects/alpha.md",
        operation: "set",
        key: "status",
        value: "active",
      });
      const prop = await v.call("read_property", {
        vault: "test",
        path: "projects/alpha.md",
        key: "status",
      });
      if (prop.ok) expect((prop.data as { value: unknown }).value).toBe("active");

      // tagging
      await v.call("add_tag", { vault: "test", path: "projects/alpha.md", tag: "project/active" });
      const tags = await v.call("get_note_tags", { vault: "test", path: "projects/alpha.md" });
      if (tags.ok) expect((tags.data as { all: string[] }).all).toContain("project/active");

      // backlinks: alpha → beta
      const bl = await v.call("get_backlinks", { vault: "test", path: "beta.md" });
      if (bl.ok)
        expect(
          (bl.data as { backlinks: Array<{ source_path: string }> }).backlinks[0]?.source_path,
        ).toBe("projects/alpha.md");

      // move beta across a folder boundary (HITL), backlink in alpha still resolves
      const moveInput = { vault: "test", from: "beta.md", to: "archive/beta.md" };
      const moveNeed = await v.call("move_note", moveInput);
      expect(moveNeed.ok).toBe(false);
      if (!moveNeed.ok) expect(moveNeed.error.code).toBe("elicit_required");
      const moved = await v.call("move_note", moveInput, {
        elicitToken: mint(v, "move_note", hashOf(moveNeed)),
      });
      expect(moved.ok).toBe(true);
      expect(v.exists("archive/beta.md")).toBe(true);
      expect(v.exists("beta.md")).toBe(false);
      const bl2 = await v.call("get_backlinks", { vault: "test", path: "archive/beta.md" });
      if (bl2.ok) expect((bl2.data as { total: number }).total).toBe(1);

      // delete alpha (destructive HITL) → lands in .trash
      const delInput = { vault: "test", path: "projects/alpha.md" };
      const delNeed = await v.call("delete_note", delInput);
      expect(delNeed.ok).toBe(false);
      if (!delNeed.ok) expect(delNeed.error.code).toBe("elicit_required");
      const deleted = await v.call("delete_note", delInput, {
        elicitToken: mint(v, "delete_note", hashOf(delNeed)),
      });
      expect(deleted.ok).toBe(true);
      expect(v.exists("projects/alpha.md")).toBe(false);
      expect(v.exists(".trash/projects/alpha.md")).toBe(true);

      // audit: every dispatch left a row; both elicit cycles and successes are recorded
      const ev = v.events();
      expect(ev.length).toBeGreaterThanOrEqual(13);
      expect(ev.filter((e) => e.tool_name === "write_note" && e.status === "ok")).toHaveLength(2);
      expect(
        ev.some((e) => e.tool_name === "move_note" && e.error_code === "elicit_required"),
      ).toBe(true);
      expect(ev.some((e) => e.tool_name === "move_note" && e.status === "ok")).toBe(true);
      expect(
        ev.some((e) => e.tool_name === "delete_note" && e.error_code === "elicit_required"),
      ).toBe(true);
      expect(ev.some((e) => e.tool_name === "delete_note" && e.status === "ok")).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("enforces folder ACL through the pipeline and audits the denial", async () => {
    const v = makeTestVault({ acl: { writePaths: ["allowed/**"] } });
    try {
      const denied = await v.call("write_note", {
        vault: "test",
        path: "secret/x.md",
        content: "z",
      });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe("acl_denied");
      expect(v.exists("secret/x.md")).toBe(false);

      const ok = await v.call("write_note", { vault: "test", path: "allowed/x.md", content: "z" });
      expect(ok.ok).toBe(true);
      expect(v.exists("allowed/x.md")).toBe(true);

      const ev = v.events();
      expect(ev.some((e) => e.tool_name === "write_note" && e.error_code === "acl_denied")).toBe(
        true,
      );
      expect(ev.some((e) => e.tool_name === "write_note" && e.status === "ok")).toBe(true);
    } finally {
      v.cleanup();
    }
  });
});
