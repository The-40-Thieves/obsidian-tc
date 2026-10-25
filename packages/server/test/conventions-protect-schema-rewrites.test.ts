// GH #1384: a protected SCHEMA.md layer is not a link-maintenance target. move_note, bulk_move_notes
// and move_attachment repoint the links in every note that links the moved target, outside the write
// whitelist (a deliberate carve-out), and a layer's body and its block-rule values are such notes. With
// `conventions.protectSchemaFiles` on and no `admin:conventions` scope, the layer is left byte-identical
// and reported under its own key. With the scope, or the flag off, it is rewritten as before.
import { describe, expect, it } from "vitest";
import { registerM3Tools } from "../src/tools/m3";
import { buildBulkTools } from "../src/tools/m6/bulk-tools";
import { CHECKED, confirmedCall, withVault } from "./conventions-helpers";

const WRITER = new Set(["read:*", "write:*", "delete:*", "bulk:*"]);
const ADMIN_CONVENTIONS = new Set([...WRITER, "admin:conventions"]);
const PROTECTED = {
  ...CHECKED,
  protectSchemaFiles: true,
  acl: { writePaths: ["F/**"], deletePaths: ["F/**"] },
};
const LAYER =
  '---\nconventions:\n  frontmatter:\n    values: { project: ["[[Alpha]]"] }\n    severity: { project: block }\n---\nSee [[target]] and ![[old.png]]\n';

/** The M3 move tools and the bulk_move_notes tool from the M6 set. */
const registerMoveTools = (
  r: Parameters<typeof registerM3Tools>[0],
  vaultRegistry: Parameters<typeof registerM3Tools>[1]["vaultRegistry"],
): void => {
  registerM3Tools(r, { vaultRegistry } as never);
  for (const t of buildBulkTools({
    vaultRegistry,
    throttle: { maxConcurrentWritesPerVault: 4 },
  } as never))
    r.register(t);
};

/** The skip list a move result carries (absent when the layer was not skipped). */
const skipped = (data: unknown): unknown =>
  (data as { schema_not_updated?: unknown }).schema_not_updated;

/** One link-maintenance call per tool, each one that would rewrite the layer. */
const CASES: Array<[string, string, Record<string, unknown>, Record<string, string>]> = [
  [
    "move_note (body link)",
    "move_note",
    { from: "F/target.md", to: "F/renamed.md" },
    { "F/target.md": "t\n" },
  ],
  [
    "move_note (frontmatter link)",
    "move_note",
    { from: "F/Alpha.md", to: "F/Beta.md" },
    { "F/Alpha.md": "a\n" },
  ],
  [
    "bulk_move_notes",
    "bulk_move_notes",
    { moves: [{ from: "F/target.md", to: "F/renamed.md" }], dry_run: false },
    { "F/target.md": "t\n" },
  ],
  [
    "move_attachment (embed)",
    "move_attachment",
    { from: "F/old.png", to: "F/new.png" },
    { "F/old.png": "PNG" },
  ],
];

describe("link maintenance never rewrites a protected SCHEMA.md", () => {
  it.each(CASES)(
    "%s leaves F/SCHEMA.md byte-identical and reports it",
    async (_n, tool, args, extra) => {
      await withVault(
        {
          ...PROTECTED,
          registerTools: registerMoveTools,
          files: { "F/SCHEMA.md": LAYER, ...extra },
        },
        async (v) => {
          const r = await confirmedCall(
            v,
            tool,
            { vault: "test", ...args },
            { grantedScopes: WRITER },
          );
          expect(r.ok).toBe(true);
          expect(v.read("F/SCHEMA.md")).toBe(LAYER);
          expect(r.ok && skipped(r.data)).toEqual(["F/SCHEMA.md"]);
        },
      );
    },
  );

  it("with admin:conventions the layer IS rewritten, as before", async () => {
    await withVault(
      {
        ...PROTECTED,
        registerTools: registerMoveTools,
        files: { "F/SCHEMA.md": LAYER, "F/target.md": "t\n" },
      },
      async (v) => {
        const r = await confirmedCall(
          v,
          "move_note",
          { vault: "test", from: "F/target.md", to: "F/renamed.md" },
          { grantedScopes: ADMIN_CONVENTIONS },
        );
        expect(r.ok).toBe(true);
        expect(v.read("F/SCHEMA.md")).toContain("[[renamed]]");
        expect(r.ok && skipped(r.data)).toBeUndefined();
      },
    );
  });

  it("with protectSchemaFiles off (the default) the layer IS rewritten by a writer", async () => {
    await withVault(
      {
        ...CHECKED,
        registerTools: registerMoveTools,
        acl: { writePaths: ["F/**"], deletePaths: ["F/**"] },
        files: { "F/SCHEMA.md": LAYER, "F/target.md": "t\n" },
      },
      async (v) => {
        const r = await confirmedCall(
          v,
          "move_note",
          { vault: "test", from: "F/target.md", to: "F/renamed.md" },
          { grantedScopes: WRITER },
        );
        expect(r.ok).toBe(true);
        expect(v.read("F/SCHEMA.md")).toContain("[[renamed]]");
      },
    );
  });
});
