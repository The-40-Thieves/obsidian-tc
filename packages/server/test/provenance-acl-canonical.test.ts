// get_provenance judges a path the way read_note does: on its canonical identity. With `wiki ->
// private` and readPaths ["wiki/**"], the lexical name `wiki/x.md` passes the folder whitelist while
// read_note refuses the target `private/x.md`. get_provenance must not answer with that note's write
// history (principal, session, hashes) under the alias name. Each case runs through the unconfigured
// symlink and through a pinned wiki folder, as enumeration-acl-canonical.test.ts does.
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { moved, queryFixture } from "./provenance-query-helpers";

const ACL = { readPaths: ["wiki/**", "pub/**"] };
const FILES = { "private/x.md": "secret body", "pub/a.md": "public body" };

type Variant = { wikiFolder?: string; centralAcl?: boolean };
const VARIANTS: Array<[string, Variant]> = [
  ["unconfigured symlink", {}],
  ["pinned wiki folder", { wikiFolder: "wiki", centralAcl: true }],
];

/** `wiki -> private` (the target is not whitelisted) and `shared -> pub` (the target is). */
const alias = (root: string): void => {
  symlinkSync(join(root, "private"), join(root, "wiki"));
  symlinkSync(join(root, "pub"), join(root, "shared"));
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

type Fx = Awaited<ReturnType<typeof queryFixture>>;
type Result = Awaited<ReturnType<Fx["get"]>>;

async function make(extra: Variant, over: Partial<Parameters<typeof queryFixture>[0]> = {}) {
  const f = await queryFixture({ files: FILES, acl: ACL, setup: alias, ...extra, ...over });
  cleanups.push(f.cleanup);
  return f;
}

/** The refusal's observable shape with the path itself masked, so two paths can be compared. */
function shape(r: Result, path: string): string {
  expect(r.ok).toBe(false);
  if (r.ok) return "";
  const { code, message, details } = r.error as unknown as Record<string, unknown>;
  return JSON.stringify({ code, message, details }).split(path).join("<path>");
}

describe.skipIf(process.platform === "win32")("get_provenance judges the canonical target", () => {
  describe.each(VARIANTS)("%s", (_label, extra) => {
    it("the incident: a write on the alias is refused as never-written, and names no principal or session", async () => {
      const f = await make(extra);
      f.add({ paths: ["wiki/x.md"], verified: { principal: "alice", session_id: "s-1" } });
      const read = await f.tv.call("read_note", { vault: f.tv.id, path: "wiki/x.md" });
      expect(read.ok).toBe(false); // the premise: read_note refuses the alias
      if (!read.ok) expect(read.error.code).toBe("acl_denied");
      const hidden = await f.get({ path: "wiki/x.md" });
      const never = await f.get({ path: "pub/never.md" });
      expect(shape(hidden, "wiki/x.md")).toBe(shape(never, "pub/never.md"));
      expect(!hidden.ok && hidden.error.code).toBe("not_found");
      const text = JSON.stringify(hidden);
      expect(text).not.toContain("alice");
      expect(text).not.toContain("s-1");
    });

    it("a bulk record lists and hashes only the paths the caller may read", async () => {
      const f = await make(extra);
      const seq = f.add({ paths: ["pub/a.md", "wiki/x.md"] });
      const stored = (
        f.tv.db.prepare("SELECT hash FROM write_provenance WHERE seq = ?").get(seq) as {
          hash: string;
        }
      ).hash;
      const r = await f.get({ path: "pub/a.md", response_format: "detailed" });
      expect(r.ok).toBe(true);
      const text = JSON.stringify(r);
      expect(text).not.toContain("wiki/x.md");
      expect(text).not.toContain("private");
      if (!r.ok) return;
      const records = (
        r.data as {
          records: Array<{
            paths: Array<{ path: string }>;
            hash: string;
            paths_truncated?: unknown;
          }>;
        }
      ).records;
      const rec = records[0];
      expect(records).toHaveLength(1);
      expect(rec?.paths.map((p) => p.path)).toEqual(["pub/a.md"]);
      expect(rec?.paths_truncated).toBeUndefined();
      expect(rec?.hash).not.toBe(stored);
    });

    it("a move out of the alias is not followed back into the denied target", async () => {
      const f = await make(extra);
      f.add({ tool: "move_note", paths: moved("wiki/old.md", "pub/new.md") });
      const r = await f.get({ path: "pub/new.md" });
      expect(r.ok).toBe(true);
      const text = JSON.stringify(r);
      expect(text).not.toContain("wiki/old.md");
      expect(text).not.toContain("private");
      if (r.ok) expect((r.data as { previous_paths: string[] }).previous_paths).toEqual([]);
    });

    it("a deleted note under the alias is refused as never-written", async () => {
      const f = await make(extra);
      f.add({ paths: ["wiki/gone.md"] });
      const hidden = await f.get({ path: "wiki/gone.md" });
      const never = await f.get({ path: "pub/never.md" });
      expect(shape(hidden, "wiki/gone.md")).toBe(shape(never, "pub/never.md"));
    });

    it("regression guard: a deleted note in a readable folder keeps its history", async () => {
      const f = await make(extra);
      f.add({ paths: ["pub/gone.md"] });
      const r = await f.get({ path: "pub/gone.md" });
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.data as { records: unknown[] }).records).toHaveLength(1);
    });

    it("regression guard: a readable alias keeps its history under the alias name", async () => {
      // `shared/**` is whitelisted too, so the lexical name passes today and must still pass.
      const f = await make(extra, { acl: { readPaths: ["wiki/**", "pub/**", "shared/**"] } });
      f.add({ paths: ["shared/a.md"] });
      const r = await f.get(
        { path: "shared/a.md" },
        { grantedScopes: new Set(["read:notes", "read:provenance"]) },
      );
      expect(r.ok).toBe(true);
    });

    // RESIDUAL, flagged: resolution of a DANGLING in-vault alias (`dead -> missing`) falls back to the
    // lexical name, as enforcePathAcl does for any path it cannot realpath. get_provenance answers the
    // same decision as read_note, so this asserts what is observed rather than a fail-closed rule the
    // resolver does not implement; changing the resolver is a separate decision.
    it("a dangling in-vault alias is judged by its lexical name, as enforcePathAcl judges it (observed)", async () => {
      const f = await make(extra, {
        acl: { readPaths: ["wiki/**", "pub/**", "dead/**"] },
        setup: (root: string) => {
          alias(root);
          symlinkSync(join(root, "missing"), join(root, "dead"));
        },
      });
      f.add({ paths: ["dead/x.md"] });
      const alone = await f.get({ path: "dead/x.md" });
      expect(alone.ok).toBe(true);
    });
  });
});
