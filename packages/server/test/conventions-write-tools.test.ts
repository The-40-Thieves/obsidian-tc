// The folder conventions check on the writers that are not write_note: the metadata, table, task, restore
// and periodic tools. A write that leaves a note untyped warns naming that note and the write stands; a
// write that leaves it typed carries no `conventions` key; a call that changes no note reports nothing.
import { describe, expect, it } from "vitest";
import { CapabilityCache } from "../src/bridge";
import type { ToolRegistry } from "../src/mcp/registry";
import { registerM3Tools } from "../src/tools/m3";
import { registerM4Tools } from "../src/tools/m4";
import type { VaultRegistry } from "../src/vault/registry";
import {
  CHECKED,
  confirmedCall,
  expectClean,
  expectMissingRequired,
  REQUIRE_TYPE,
  withVault,
} from "./conventions-helpers";
import type { TestVault } from "./m1-helpers";

/** The M3 (table, periodic) and M4 (task) writers, registered beside the M1 tools makeTestVault wires. */
const WRITERS = {
  registerTools: (registry: ToolRegistry, vaultRegistry: VaultRegistry) => {
    registerM3Tools(registry, { vaultRegistry });
    registerM4Tools(registry, {
      vaultRegistry,
      capabilities: new CapabilityCache(),
      bridgeFor: () => undefined,
    });
  },
};

const NOTE = "meetings/m.md";
const SCHEMA = "meetings/SCHEMA.md";
const DAILY = "2026-06-18.md";

/** A note under the meetings layer: `typed` adds the `type` that layer requires. */
function noteText(typed: boolean, frontmatter: string[], body: string): string {
  const lines = [...(typed ? ["type: meeting"] : []), ...frontmatter];
  return lines.length > 0 ? `---\n${lines.join("\n")}\n---\n${body}` : body;
}

const ALIGNED = "| b | a |\n|---|---|\n| 2 | x |\n| 1 | y |\n";
const MISALIGNED = "|b|a|\n|-|-|\n|2|x|\n";

/** One writer per row: the note it starts from, and the input that makes it change that note. */
const CASES = [
  { tool: "add_tag", frontmatter: [], body: "body\n", input: { tag: "wip" } },
  { tool: "remove_tag", frontmatter: ["tags: [old]"], body: "body\n", input: { tag: "old" } },
  {
    tool: "update_frontmatter",
    frontmatter: [],
    body: "body\n",
    input: { operation: "set", key: "status", value: "open" },
  },
  { tool: "format_table", frontmatter: [], body: MISALIGNED, input: {} },
  { tool: "insert_table_row", frontmatter: [], body: ALIGNED, input: { values: ["3", "z"] } },
  { tool: "insert_table_column", frontmatter: [], body: ALIGNED, input: { header: "c" } },
  {
    tool: "sort_table_by_column",
    frontmatter: [],
    body: ALIGNED,
    input: { column: 0, numeric: true },
  },
  {
    tool: "update_task",
    frontmatter: [],
    body: "- [ ] write the report\n",
    // The task sits on line 1 of an untyped note, and below the one-line `type` frontmatter of a typed one.
    input: (typed: boolean) => ({ line: typed ? 4 : 1, set: { status: "done" } }),
  },
];

describe.each(CASES)("$tool and the folder conventions check", (c) => {
  const call = (v: TestVault, typed: boolean) =>
    v.call(c.tool, {
      vault: "test",
      path: NOTE,
      ...(typeof c.input === "function" ? c.input(typed) : c.input),
    });

  it(`${c.tool} warns on an untyped note, names it, and the write stands`, async () => {
    await withVault(
      {
        ...CHECKED,
        ...WRITERS,
        files: { [SCHEMA]: REQUIRE_TYPE, [NOTE]: noteText(false, c.frontmatter, c.body) },
      },
      async (v) => {
        const before = v.read(NOTE);
        const r = await call(v, false);
        expectMissingRequired(r, NOTE, SCHEMA);
        expect(v.read(NOTE)).not.toBe(before);
      },
    );
  });

  it(`${c.tool} carries no conventions key when the note it writes is typed`, async () => {
    await withVault(
      {
        ...CHECKED,
        ...WRITERS,
        files: { [SCHEMA]: REQUIRE_TYPE, [NOTE]: noteText(true, c.frontmatter, c.body) },
      },
      async (v) => {
        const before = v.read(NOTE);
        const r = await call(v, true);
        expectClean(r);
        expect(v.read(NOTE)).not.toBe(before);
      },
    );
  });
});

describe("restore_note and the folder conventions check", () => {
  const SNAPSHOTS = { enabled: true, retention: 5 };

  it("restore_note warns naming the note when the snapshot it restores is untyped", async () => {
    await withVault(
      {
        ...CHECKED,
        ...WRITERS,
        snapshots: SNAPSHOTS,
        files: { [SCHEMA]: REQUIRE_TYPE, [NOTE]: "old\n" },
      },
      async (v) => {
        const snap = await v.call("snapshot_note", { vault: "test", path: NOTE });
        const snapshot_id = snap.ok ? (snap.data as { snapshot_id: number }).snapshot_id : 0;
        v.write(NOTE, noteText(true, [], "new\n"));
        const r = await confirmedCall(v, "restore_note", {
          vault: "test",
          path: NOTE,
          snapshot_id,
        });
        expectMissingRequired(r, NOTE, SCHEMA);
        expect(v.read(NOTE)).toBe("old\n");
      },
    );
  });

  it("restore_note carries no conventions key when the snapshot it restores is typed", async () => {
    await withVault(
      {
        ...CHECKED,
        ...WRITERS,
        snapshots: SNAPSHOTS,
        files: { [SCHEMA]: REQUIRE_TYPE, [NOTE]: noteText(true, [], "old\n") },
      },
      async (v) => {
        const snap = await v.call("snapshot_note", { vault: "test", path: NOTE });
        const snapshot_id = snap.ok ? (snap.data as { snapshot_id: number }).snapshot_id : 0;
        v.write(NOTE, "new\n");
        const r = await confirmedCall(v, "restore_note", {
          vault: "test",
          path: NOTE,
          snapshot_id,
        });
        expectClean(r);
        expect(v.read(NOTE)).toBe(noteText(true, [], "old\n"));
      },
    );
  });
});

describe("periodic writers and the folder conventions check", () => {
  // The root SCHEMA.md governs the daily note, which the default periodic config places at the vault root.
  const ROOT_SCHEMA = { "SCHEMA.md": REQUIRE_TYPE };

  it("create_periodic_note warns naming the computed periodic note path", async () => {
    await withVault({ ...CHECKED, ...WRITERS, files: ROOT_SCHEMA }, async (v) => {
      const r = await v.call("create_periodic_note", {
        vault: "test",
        period: "daily",
        date: "2026-06-18",
      });
      expectMissingRequired(r, DAILY, "SCHEMA.md");
      expect(r.ok && (r.data as { path: string }).path).toBe(DAILY);
    });
  });

  it("append_to_periodic_note warns naming the computed periodic note path", async () => {
    await withVault({ ...CHECKED, ...WRITERS, files: ROOT_SCHEMA }, async (v) => {
      const r = await v.call("append_to_periodic_note", {
        vault: "test",
        period: "daily",
        date: "2026-06-18",
        content: "entry\n",
      });
      expectMissingRequired(r, DAILY, "SCHEMA.md");
      expect(r.ok && (r.data as { path: string }).path).toBe(DAILY);
    });
  });

  it("find_or_create_periodic_note warns when it creates the note", async () => {
    await withVault({ ...CHECKED, ...WRITERS, files: ROOT_SCHEMA }, async (v) => {
      const r = await v.call("find_or_create_periodic_note", {
        vault: "test",
        period: "daily",
        date: "2026-06-18",
      });
      expectMissingRequired(r, DAILY, "SCHEMA.md");
    });
  });

  it("find_or_create_periodic_note stays silent when it finds the existing note", async () => {
    await withVault(
      { ...CHECKED, ...WRITERS, files: { ...ROOT_SCHEMA, [DAILY]: "found\n" } },
      async (v) => {
        const r = await v.call("find_or_create_periodic_note", {
          vault: "test",
          period: "daily",
          date: "2026-06-18",
        });
        expectClean(r);
        expect(v.read(DAILY)).toBe("found\n");
      },
    );
  });
});

describe("unchanged notes and the folder conventions check", () => {
  it("unchanged: remove_tag of an absent tag reports no warning for the untouched note", async () => {
    await withVault(
      {
        ...CHECKED,
        ...WRITERS,
        files: { [SCHEMA]: REQUIRE_TYPE, [NOTE]: noteText(false, ["tags: [keep]"], "body\n") },
      },
      async (v) => {
        const before = v.read(NOTE);
        const r = await v.call("remove_tag", { vault: "test", path: NOTE, tag: "absent" });
        expectClean(r);
        expect(v.read(NOTE)).toBe(before);
      },
    );
  });
});
