// The folder conventions sink against a real vault on disk: which named notes it stats, which it judges,
// and what it leaves alone. Drives conventionsChecker directly so each test pins one line of its contract.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conventionsChecker } from "../src/mcp/registry/conventions-scope";
import type { CallerContext, ToolDefinition } from "../src/mcp/registry/types";
import { buildAcls } from "../src/runtime/acl-build";
import { contentHash } from "../src/vault/paths";
import { VaultRegistry } from "../src/vault/registry";
import { REQUIRE_TYPE } from "./conventions-helpers";
import { makeTestVault } from "./m1-helpers";
import { makeTempDir, rmTemp } from "./tmp";

// Records the layer eviction a SCHEMA.md write triggers; the real eviction still runs.
const evicted = vi.hoisted(() => [] as string[]);
vi.mock("../src/conventions/resolve", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/conventions/resolve")>();
  return {
    ...real,
    evictConventionsLayer: (vaultId: string, path: string) => {
      evicted.push(`${vaultId}:${path}`);
      real.evictConventionsLayer(vaultId, path);
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmTemp(r);
});

/** A real vault on disk holding `files`, registered as vault `t` with an optional wiki config. */
function vaultOf(files: Record<string, string>, wiki?: { folder: string; rawFolder?: string }) {
  const root = makeTempDir("obtc-checker-");
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  const registry = new VaultRegistry(
    [{ id: "t", path: root, ...(wiki ? { wiki } : {}) }],
    undefined,
    undefined,
    { boundVaultOnly: false },
  );
  return { root, sink: conventionsChecker(registry) };
}

const ctxOf = (acl?: unknown): CallerContext =>
  ({ vaultId: "t", acl, grantedScopes: new Set(["*"]) }) as unknown as CallerContext;

/** A tool that names `paths` for write, as its pathAcl does. */
const namesWrites = (...paths: string[]): ToolDefinition =>
  ({
    name: "append_note",
    pathAcl: () => paths.map((path) => ({ op: "write", path })),
  }) as unknown as ToolDefinition;

describe("conventions checker on a real vault", () => {
  it("a note changed again after the write is not judged", async () => {
    const { root, sink } = vaultOf({ "meetings/SCHEMA.md": REQUIRE_TYPE });
    const ctx = ctxOf();
    const pending = await sink.begin(namesWrites("meetings/m.md"), {}, ctx, root);
    writeFileSync(join(root, "meetings/m.md"), "x\n");
    // The write reported the hash of other bytes: the note moved on, so it is not this write's judgment.
    const stale = { path: "meetings/m.md", content_hash: contentHash("other\n") };
    expect(await sink.check(pending, stale, ctx, root, new Set())).toBeUndefined();
    // Control: the reported hash names the bytes on disk, so the same note is judged.
    const fresh = { path: "meetings/m.md", content_hash: contentHash("x\n") };
    expect(await sink.check(pending, fresh, ctx, root, new Set())).toBeDefined();
  });

  it("a named note the write left unchanged is not judged", async () => {
    const { root, sink } = vaultOf({
      "meetings/SCHEMA.md": REQUIRE_TYPE,
      "meetings/old.md": "no frontmatter\n",
    });
    const ctx = ctxOf();
    const pending = await sink.begin(namesWrites("meetings/old.md"), {}, ctx, root);
    expect(await sink.check(pending, {}, ctx, root, new Set())).toBeUndefined();
    // Control: once the note is rewritten, its stat changed and it is judged.
    writeFileSync(join(root, "meetings/old.md"), "no frontmatter, rewritten\n");
    expect(await sink.check(pending, {}, ctx, root, new Set())).toBeDefined();
  });

  it("a named note the caller may not write is not judged", async () => {
    const { root, sink } = vaultOf({
      "SCHEMA.md": REQUIRE_TYPE,
      "secret/old.md": "no frontmatter\n",
      "open/old.md": "no frontmatter\n",
    });
    const { acl } = buildAcls(
      { readOnly: false, defaultScopes: [], rules: [], readPaths: ["**"], writePaths: ["open/**"] },
      [{ id: "t", path: root }],
    );
    const ctx = ctxOf(acl);
    const pending = await sink.begin(namesWrites("secret/old.md", "open/old.md"), {}, ctx, root);
    writeFileSync(join(root, "secret/old.md"), "no frontmatter, rewritten\n");
    writeFileSync(join(root, "open/old.md"), "no frontmatter, rewritten\n");
    // Only the note the caller may write is judged: one warning, not two.
    const out = await sink.check(pending, {}, ctx, root, new Set());
    expect((out as { warnings?: unknown[] } | undefined)?.warnings).toHaveLength(1);
  });

  it("a raw-folder note is not judged", async () => {
    const { root, sink } = vaultOf(
      { "SCHEMA.md": REQUIRE_TYPE, "raw/src.md": "raw\n" },
      { folder: "wiki", rawFolder: "raw" },
    );
    const ctx = ctxOf();
    const pending = await sink.begin(namesWrites("raw/src.md"), {}, ctx, root);
    writeFileSync(join(root, "raw/src.md"), "raw, rewritten\n");
    expect(await sink.check(pending, {}, ctx, root, new Set())).toBeUndefined();
  });

  it("a move from a source the caller cannot read gets no verdict, and echoes none of it", async () => {
    const SECRET_VALUE = "zzTOPSECRETVALUE";
    const STRICT = `---\nconventions:\n  frontmatter:\n    values: { status: [current] }\n    severity: { status: block }\n---\n# rules\n`;
    const { root, sink } = vaultOf({
      "strict/SCHEMA.md": STRICT,
      "secret/a.md": `---\nstatus: ${SECRET_VALUE}\n---\nbody\n`,
    });
    const text = `---\nstatus: ${SECRET_VALUE}\n---\nbody\n`;
    const dest = join(root, "strict/a.md");
    const aclFor = (readPaths: string[]) =>
      buildAcls({ readOnly: false, defaultScopes: [], rules: [], readPaths, writePaths: ["**"] }, [
        { id: "t", path: root },
      ]).acl;
    // The gate for a move into strict/a.md, with the source the caller may or may not read.
    const gateFor = async (ctx: CallerContext) => {
      const gate = sink.gate?.(
        await sink.begin(namesWrites("strict/a.md"), {}, ctx, root),
        ctx,
        root,
      );
      if (gate?.origin === undefined) throw new Error("the sink has no origin-aware gate");
      gate.origin("strict/a.md", "secret/a.md");
      return gate;
    };
    // Control: a caller who reads the source is judged, so the move is blocked by the destination's rule.
    const reader = await gateFor(ctxOf(aclFor(["**"])));
    expect(() => reader.check(dest, text)).toThrow();
    // A caller who cannot read the source gets no verdict: nothing is blocked, and no source bytes show.
    const blind = await gateFor(ctxOf(aclFor(["strict/**"])));
    expect(() => blind.check(dest, text)).not.toThrow();
  });

  it("a SCHEMA.md write evicts its cached layer", async () => {
    const v = makeTestVault({
      centralAcl: true,
      conventions: true,
      files: { "meetings/m0.md": "x\n" },
    });
    try {
      const r = await v.call("write_note", {
        vault: "test",
        path: "meetings/SCHEMA.md",
        content: REQUIRE_TYPE,
      });
      expect(r.ok).toBe(true);
      expect(evicted).toContain("test:meetings/SCHEMA.md");
    } finally {
      v.cleanup();
    }
  });
});
