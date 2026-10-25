// The folder conventions write gate: a `severity: block` rule refuses a write that ADDS a blocking
// violation, before any byte reaches disk. A partial fix, an unrelated edit and a warn rule all pass;
// a caller who cannot read the old note is judged on its own content; a check that throws fails open.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveConventions } from "../src/conventions/resolve";
import { registerM6Tools } from "../src/tools/m6";
import * as notesIo from "../src/vault/notes-io";
import {
  CHECKED,
  confirmedCall,
  expectClean,
  snapshotTotal,
  withVault,
} from "./conventions-helpers";
import { makeM6Vault } from "./m6-helpers";

vi.mock("../src/vault/notes-io", async (orig) => {
  const actual = await orig<typeof import("../src/vault/notes-io")>();
  return { ...actual, trashNote: vi.fn(actual.trashNote) };
});

vi.mock("../src/conventions/resolve", async (orig) => {
  const actual = await orig<typeof import("../src/conventions/resolve")>();
  return { ...actual, resolveConventions: vi.fn(actual.resolveConventions) };
});

/** A SCHEMA.md layer that requires `type` and `status`, and only accepts draft or current as status. */
const rules = (severity: "block" | "warn"): string =>
  "---\nconventions:\n  frontmatter:\n    required: [type, status]\n    values: { status: [draft, current] }\n" +
  `    severity: { type: ${severity}, status: ${severity} }\n---\n# rules\n`;

const MEETING = "meetings/SCHEMA.md";

/** A vault with the M6 bulk writers registered, under the same rules as the M1 cases. */
function bulkVault(files: Record<string, string>) {
  return makeM6Vault({
    conventions: true,
    files,
    register: (reg, deps) =>
      registerM6Tools(reg, {
        ...deps,
        toolSurface: () => ({ config: reg.visibilityConfig(), tools: reg.list() }),
      }),
  });
}

describe("write_note under a block rule", () => {
  it("refuses a new note missing a block-required property and writes nothing", async () => {
    await withVault({ ...CHECKED, files: { [MEETING]: rules("block") } }, async (v) => {
      const r = await v.call("write_note", {
        vault: "test",
        mode: "upsert",
        path: "meetings/m.md",
        content: "x\n",
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe("convention_blocked");
      const d = r.error.details as {
        path: string;
        violations: { property?: string; code: string; source: string }[];
      };
      expect(d.path).toBe("meetings/m.md");
      expect(d.violations.map((x) => [x.property, x.code, x.source])).toEqual([
        ["type", "missing_required", MEETING],
        ["status", "missing_required", MEETING],
      ]);
      expect(JSON.stringify(r.error)).toContain("get_conventions");
      expect(existsSync(join(v.root, "meetings/m.md"))).toBe(false);
    });
  });

  it("writes and warns when the same rule is only warn", async () => {
    await withVault({ ...CHECKED, files: { [MEETING]: rules("warn") } }, async (v) => {
      const r = await v.call("write_note", {
        vault: "test",
        mode: "upsert",
        path: "meetings/m.md",
        content: "x\n",
      });
      expect(r.ok).toBe(true);
      expect(v.read("meetings/m.md")).toBe("x\n");
      const field = r.ok
        ? (r.data as { conventions?: { warnings?: { level: string }[] } })
        : undefined;
      expect(field?.conventions?.warnings?.[0]?.level).toBe("warn");
    });
  });

  it("passes a partial fix of an already-broken note", async () => {
    await withVault(
      {
        ...CHECKED,
        files: { [MEETING]: rules("block"), "meetings/m.md": "---\nstatus: bogus\n---\n" },
      },
      async (v) => {
        const r = await confirmedCall(v, "write_note", {
          mode: "upsert",
          vault: "test",
          path: "meetings/m.md",
          content: "---\ntype: meeting\nstatus: bogus\n---\n",
        });
        expect(r.ok).toBe(true);
        expect(v.read("meetings/m.md")).toBe("---\ntype: meeting\nstatus: bogus\n---\n");
      },
    );
  });

  it("refuses a worsened note and leaves its bytes unchanged", async () => {
    const before = "---\ntype: meeting\nstatus: bogus\n---\n";
    await withVault(
      { ...CHECKED, files: { [MEETING]: rules("block"), "meetings/m.md": before } },
      async (v) => {
        const r = await confirmedCall(v, "write_note", {
          mode: "upsert",
          vault: "test",
          path: "meetings/m.md",
          content: "---\ntype: meeting\nstatus: nope\n---\n",
        });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error.code).toBe("convention_blocked");
        expect(v.read("meetings/m.md")).toBe(before);
      },
    );
  });

  it("passes a body edit to an already-broken note", async () => {
    const before = "---\ntype: meeting\nstatus: bogus\n---\nold body\n";
    await withVault(
      { ...CHECKED, files: { [MEETING]: rules("block"), "meetings/m.md": before } },
      async (v) => {
        const r = await confirmedCall(v, "write_note", {
          mode: "upsert",
          vault: "test",
          path: "meetings/m.md",
          content: "---\ntype: meeting\nstatus: bogus\n---\nnew body\n",
        });
        expect(r.ok).toBe(true);
        expect(v.read("meetings/m.md")).toBe("---\ntype: meeting\nstatus: bogus\n---\nnew body\n");
      },
    );
  });

  it("judges a note the caller may write but not read as new, and never echoes its old bytes", async () => {
    const old = "---\ntype: meeting\nstatus: bogus\n---\nOLD-BODY-SECRET\n";
    await withVault(
      {
        ...CHECKED,
        acl: { readPaths: ["open/**", "**/SCHEMA.md"], writePaths: ["**"] },
        files: { "locked/SCHEMA.md": rules("block"), "locked/m.md": old },
      },
      async (v) => {
        const refused = await confirmedCall(v, "write_note", {
          mode: "upsert",
          vault: "test",
          path: "locked/m.md",
          content: "---\ntype: meeting\nstatus: bogus\n---\nnew\n",
        });
        expect(refused.ok).toBe(false);
        if (refused.ok) return;
        expect(refused.error.code).toBe("convention_blocked");
        expect(JSON.stringify(refused)).not.toContain("OLD-BODY-SECRET");
        const passes = await confirmedCall(v, "write_note", {
          mode: "upsert",
          vault: "test",
          path: "locked/m.md",
          content: "---\ntype: meeting\nstatus: draft\n---\nnew\n",
        });
        expect(passes.ok).toBe(true);
      },
    );
  });

  it("ignores a block rule in a SCHEMA.md the caller cannot read", async () => {
    await withVault(
      {
        ...CHECKED,
        acl: { readPaths: ["open/**"], writePaths: ["**"] },
        files: { "meetings/SCHEMA.md": rules("block") },
      },
      async (v) => {
        const r = await v.call("write_note", {
          vault: "test",
          mode: "upsert",
          path: "meetings/m.md",
          content: "x\n",
        });
        expectClean(r);
        expect(v.read("meetings/m.md")).toBe("x\n");
      },
    );
  });

  it("a name that starts with .. inside the vault is not treated as outside it (skipped as a dot-segment)", async () => {
    await withVault(
      { ...CHECKED, files: { [MEETING]: rules("block"), "SCHEMA.md": rules("block") } },
      async (v) => {
        // `..notes` is an ordinary folder name inside the vault. The gate must not read it as a parent
        // segment; the engine then skips it for its leading dot, not for being outside the root.
        const r = await v.call("write_note", {
          vault: "test",
          path: "..notes/m.md",
          content: "x\n",
        });
        expect(r.ok ? "ok" : r.error.code).toBe("ok");
        expect(v.read("..notes/m.md")).toBe("x\n");
      },
    );
  });

  it("fails open when the check throws: the write lands and the fault is reported", async () => {
    const real = await vi.importActual<typeof import("../src/conventions/resolve")>(
      "../src/conventions/resolve",
    );
    const onInternalError = vi.fn();
    await withVault(
      { ...CHECKED, registryOpts: { onInternalError }, files: { [MEETING]: rules("block") } },
      async (v) => {
        // Every resolve faults during this write, so no preflight or sink check gets a verdict.
        vi.mocked(resolveConventions).mockImplementation(() => {
          throw new Error("injected resolver fault");
        });
        try {
          const r = await v.call("write_note", {
            vault: "test",
            path: "meetings/m.md",
            content: "x\n",
          });
          expect(r.ok ? "ok" : r.error.code).toBe("ok");
          expect(v.read("meetings/m.md")).toBe("x\n");
          expect(onInternalError).toHaveBeenCalled();
        } finally {
          vi.mocked(resolveConventions).mockImplementation(real.resolveConventions);
        }
      },
    );
  });

  it("a blocked overwrite spends no confirmation and leaves no snapshot", async () => {
    const before = "---\ntype: meeting\nstatus: draft\n---\nold\n";
    await withVault(
      {
        ...CHECKED,
        snapshots: { enabled: true, retention: 10 },
        files: { [MEETING]: rules("block"), "meetings/m.md": before },
      },
      async (v) => {
        const r = await v.call("write_note", {
          vault: "test",
          mode: "upsert",
          path: "meetings/m.md",
          content: "---\nstatus: bogus\n---\nnew\n",
        });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error.code).toBe("convention_blocked");
        expect(r.error.retryable).toBe(false);
        expect(await snapshotTotal(v, "meetings/m.md")).toBe(0);
      },
    );
  });
});

describe("write gate exemptions and batches", () => {
  it("restore_note writes a non-compliant snapshot and warns instead of refusing", async () => {
    await withVault(
      {
        ...CHECKED,
        snapshots: { enabled: true, retention: 10 },
        files: { "m.md": "---\nstatus: bogus\n---\nold\n" },
      },
      async (v) => {
        const snap = await v.call("snapshot_note", { vault: "test", path: "m.md" });
        const snapshotId = snap.ok ? (snap.data as { snapshot_id: number }).snapshot_id : -1;
        v.write("m.md", "---\ntype: meeting\nstatus: draft\n---\nnew\n");
        v.write("SCHEMA.md", rules("block"));
        const r = await confirmedCall(v, "restore_note", {
          vault: "test",
          path: "m.md",
          snapshot_id: snapshotId,
        });
        expect(r.ok).toBe(true);
        expect(v.read("m.md")).toBe("---\nstatus: bogus\n---\nold\n");
      },
    );
  });

  it("bulk_create_notes fails only the blocked item and writes the rest", async () => {
    const v = bulkVault({ [MEETING]: rules("block") });
    try {
      const r = await v.callConfirmed("bulk_create_notes", {
        vault: "test",
        items: [
          { path: "meetings/bad.md", content: "x\n" },
          { path: "meetings/good.md", content: "---\ntype: meeting\nstatus: draft\n---\n" },
        ],
      });
      expect(r.ok ? "ok" : JSON.stringify(r.error)).toBe("ok");
      const results = (
        r.ok ? (r.data as { results: { error?: { code: string } }[] }).results : []
      ) as {
        error?: { code: string };
      }[];
      expect(results[0]?.error?.code).toBe("convention_blocked");
      expect(results[1]?.error).toBeUndefined();
      expect(existsSync(join(v.root, "meetings/bad.md"))).toBe(false);
      expect(existsSync(join(v.root, "meetings/good.md"))).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("a corrected retry under the same idempotency key runs after a blocked attempt", async () => {
    const v = bulkVault({ [MEETING]: rules("block") });
    try {
      const item = { path: "meetings/m.md", content: "x\n", idempotency_key: "K-block-1" };
      const first = await v.callConfirmed("bulk_create_notes", { vault: "test", items: [item] });
      expect(first.ok ? "ok" : first.error.code).toBe("ok");
      const firstCode = first.ok
        ? (first.data as { results: { error?: { code: string } }[] }).results[0]?.error?.code
        : undefined;
      expect(firstCode).toBe("convention_blocked");
      const retry = await v.callConfirmed("bulk_create_notes", {
        vault: "test",
        items: [{ ...item, content: "---\ntype: meeting\nstatus: draft\n---\n" }],
      });
      const retryCode = retry.ok
        ? (retry.data as { results: { error?: { code: string } }[] }).results[0]?.error?.code
        : retry.error.code;
      expect(retryCode).toBeUndefined();
      expect(v.read("meetings/m.md")).toBe("---\ntype: meeting\nstatus: draft\n---\n");
    } finally {
      v.cleanup();
    }
  });
});

const { trashNote } = notesIo;

describe("bulk_move_notes rewrites under a block rule", () => {
  it("refuses a rewrite the gate blocks before anything is trashed: nothing moves, nothing snapshotted, notes unchanged", async () => {
    // meetings/X.md is the destination of a refused row (its source is missing), so it is not replaced,
    // and it is a backlink-rewrite target of the moved B.md. The rewrite moves X's `link` off its one
    // allowed value, so the gate blocks it. The plan names X as a write, so it is judged, not exempt.
    // The overwrite of meetings/Y.md (an ok row) is trashed before the batch is written: the refusal
    // must come before that trash, and the trash must not be left behind.
    const linkRule =
      '---\nconventions:\n  frontmatter:\n    values: { link: ["[[B]]"] }\n    severity: { link: block }\n---\n# rules\n';
    const v = bulkVault({
      [MEETING]: linkRule,
      "B.md": "body\n",
      "D.md": "---\ntype: meeting\n---\nD\n",
      "meetings/Y.md": "old\n",
      "meetings/X.md": '---\nlink: "[[B]]"\n---\nsee [[B]]\n',
    });
    try {
      const before = { b: v.read("B.md"), x: v.read("meetings/X.md"), y: v.read("meetings/Y.md") };
      const r = await v.callConfirmed("bulk_move_notes", {
        vault: "test",
        dry_run: false,
        overwrite: true,
        moves: [
          { from: "D.md", to: "meetings/Y.md" },
          { from: "B.md", to: "C.md" },
          { from: "Q.md", to: "meetings/X.md" },
        ],
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe("convention_blocked");
      expect(trashNote).not.toHaveBeenCalled();
      expect(v.exists("C.md")).toBe(false);
      expect(v.read("B.md")).toBe(before.b);
      expect(v.read("meetings/X.md")).toBe(before.x);
      expect(v.read("meetings/Y.md")).toBe(before.y);
      expect(v.exists("D.md")).toBe(true);
      const snaps = (await v.call("list_snapshots", { vault: "test", path: "meetings/X.md" })) as {
        ok: boolean;
        data?: { total: number };
      };
      expect(snaps.data?.total).toBe(0);
      const trash = join(v.root, ".trash");
      expect(existsSync(trash) ? readdirSync(trash, { recursive: true }) : []).toEqual([]);
    } finally {
      v.cleanup();
    }
  });
});
