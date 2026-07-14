// The SAME bug as advisory A1 (see acl-enum-fail-closed.test.ts), in the seven files that advisory
// never looked at.
//
// A1 found that four M1 tool files each carried a hand-rolled readable() which returned true on
// undefined readPaths, ignoring strictReadDefault. It was fixed by editing those four copies — and left
// the duplication in place. So the identical predicate survived, still broken, in m3/kanban, m3/base,
// m3/canvas, m3/periodic, m4/bundle, m4/ocr and m4/tasks:
//
//     function readable(acl, rel) { if (!acl || acl.readPaths === undefined) return true; ... }
//
// Under strictReadDefault:true with no readPaths, that returns TRUE for every path. list_kanban_boards
// then walks the whole vault, and for each hit calls readNote() with no enforcePathAcl — so it does not
// merely enumerate a fail-closed vault, it READS it.
//
// This test exists at the M3 layer because that is where the surviving copies live. The fix deletes all
// twelve copies in favour of the canonical readableRel() (vault/acl-read-filter.ts), which is the only
// thing that makes the class of bug non-recurring.
import { describe, expect, it } from "vitest";
import { makeM3Vault } from "./m3-helpers";

const FILES = {
  "secret/board.md":
    "---\nkanban-plugin: board\n---\n\n## Todo\n\n- [ ] topsecret card\n\n## Done\n\n",
  "secret/2026-01-01.md": "---\ntags: [daily]\n---\ntopsecret daily body\n",
};
const STRICT = { strictReadDefault: true }; // no readPaths ⇒ everything denied

describe("M3 enumeration tools honor strictReadDefault (the surviving half of advisory A1)", () => {
  it("list_kanban_boards fails closed — it must not enumerate (or read) a denied vault", async () => {
    const open = makeM3Vault({ files: FILES });
    const strict = makeM3Vault({ files: FILES, acl: STRICT });
    try {
      const o = await open.call("list_kanban_boards", { vault: "test" });
      const s = await strict.call("list_kanban_boards", { vault: "test" });
      expect(o.ok && s.ok).toBe(true);
      if (o.ok && s.ok) {
        // Without an ACL the board is found...
        expect((o.data as { total: number }).total).toBe(1);
        // ...but under strictReadDefault the whole vault is denied. Before the fix this was also 1,
        // and the path "secret/board.md" was returned to the caller.
        expect((s.data as { total: number }).total).toBe(0);
        expect(JSON.stringify(s.data)).not.toContain("secret/board.md");
      }
    } finally {
      open.cleanup();
      strict.cleanup();
    }
  });

  it("list_periodic_notes fails closed — the readableAcl copy ignored strictReadDefault too", async () => {
    const open = makeM3Vault({ files: FILES });
    const strict = makeM3Vault({ files: FILES, acl: STRICT });
    try {
      const s = await strict.call("list_periodic_notes", { vault: "test", period: "daily" });
      // Whether or not any note parses as a periodic note, a fail-closed vault must never leak a path.
      if (s.ok) expect(JSON.stringify(s.data)).not.toContain("secret/");
    } finally {
      open.cleanup();
      strict.cleanup();
    }
  });
});
