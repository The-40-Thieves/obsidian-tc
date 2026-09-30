// write_attachment: the write path of the attachment family. Runs against a registry wired the way
// production wires it (rootResolver + aclResolver + verifyElicit), because the properties under test
// — the central ACL stage, per-vault overrides, and replay_drift on an overwrite — only exist there;
// m3-helpers' registry omits rootResolver.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type AclConfigT, FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { elicitVerifier, issueElicitToken } from "../src/elicit";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { type M3Deps, registerM3Tools } from "../src/tools/m3";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { rmTemp } from "./tmp";

const OPEN: AclConfigT = { readOnly: false, defaultScopes: [], rules: [] };

// A real 1x1 PNG and a minimal PDF: the bytes must survive verbatim, including 0x00 and 0xff.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
  "base64",
);
const PDF = Buffer.concat([
  Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"),
  Buffer.from([0x00, 0xff, 0x80, 0x0a, 0x0d]),
]);

function boot(opts: { maxAttachmentBytes?: number; files?: Record<string, string | Buffer> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "obtc-wa-"));
  const otherRoot = mkdtempSync(join(tmpdir(), "obtc-wa-b-"));
  const outside = mkdtempSync(join(tmpdir(), "obtc-wa-out-"));
  const roRoot = mkdtempSync(join(tmpdir(), "obtc-wa-ro-"));
  const put = (rel: string, data: string | Buffer, base = root): void => {
    mkdirSync(dirname(join(base, rel)), { recursive: true });
    writeFileSync(join(base, rel), data);
  };
  for (const [rel, data] of Object.entries(opts.files ?? {})) put(rel, data);
  const db = openMemoryDb();
  provisionCacheDb(db);
  const roots: Record<string, string> = { test: root, locked: otherRoot, ro: roRoot };
  const acls = new Map<string, FolderAcl>([
    ["ro", new FolderAcl({ ...OPEN, readOnly: true })],
    ["locked", new FolderAcl({ ...OPEN, writePaths: ["only-here/**"] })],
  ]);
  const rootAcl = new FolderAcl(OPEN);
  const registry = new ToolRegistry({
    verifyElicit: elicitVerifier,
    rootResolver: (id) => roots[id],
    aclResolver: (id) => acls.get(id) ?? rootAcl,
  });
  const deps: M3Deps = {
    vaultRegistry: new VaultRegistry([
      { id: "test", path: root },
      { id: "locked", path: otherRoot },
      { id: "ro", path: roRoot },
    ]),
    ...(opts.maxAttachmentBytes !== undefined
      ? { maxAttachmentBytes: opts.maxAttachmentBytes }
      : {}),
  };
  registerM3Tools(registry, deps);
  const ctx = (over: Partial<CallerContext> = {}): CallerContext => ({
    caller: "test",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "test",
    db,
    acl: rootAcl,
    ...over,
  });
  const call = (name: string, input: Record<string, unknown>, over?: Partial<CallerContext>) =>
    registry.dispatch(name, input, ctx(over));
  return {
    root,
    otherRoot,
    roRoot,
    outside,
    db,
    call,
    put,
    bytes: (rel: string, base = root) => readFileSync(join(base, rel)),
    exists: (rel: string, base = root) => existsSync(join(base, rel)),
    ctx,
    cleanup: () => {
      rmTemp(root);
      rmTemp(otherRoot);
      rmTemp(roRoot);
      rmTemp(outside);
    },
  };
}

type Booted = ReturnType<typeof boot>;
type Result = Awaited<ReturnType<Booted["call"]>>;

function code(r: Result): string {
  if (r.ok) throw new Error(`expected an error, got ok: ${JSON.stringify(r.data)}`);
  return r.error.code;
}
function hashOf(r: Result): string {
  if (r.ok) throw new Error("expected an error result");
  expect(r.error.code).toBe("elicit_required");
  return (r.error.details as { args_hash: string }).args_hash;
}
function mint(b: Booted, tool: string, argsHash: string, vault = "test"): string {
  return issueElicitToken(b.db, { vaultId: vault, toolName: tool, argsHash, caller: "test" });
}
const b64 = (buf: Buffer): string => buf.toString("base64");
const sha = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

describe("write_attachment: round trip through get_attachment", () => {
  it.each([
    ["png", "img/pic.png", PNG, "image/png"],
    ["pdf", "docs/spec.pdf", PDF, "application/pdf"],
    ["zero-byte", "empty.png", Buffer.alloc(0), "image/png"],
  ])("%s bytes come back identical", async (_n, path, data, mime) => {
    const b = boot();
    try {
      const w = await b.call("write_attachment", { vault: "test", path, content: b64(data) });
      expect(w.ok).toBe(true);
      if (w.ok) {
        const d = w.data as Record<string, unknown>;
        expect(d).toMatchObject({
          vault: "test",
          path,
          created: true,
          overwritten: false,
          size: data.length,
          mime,
          sha256: sha(data),
          trashed_prev_to: null,
        });
      }
      expect(b.bytes(path).equals(data)).toBe(true);
      const r = await b.call("get_attachment", { vault: "test", path });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { content: string; size: number; mime: string };
        expect(Buffer.from(d.content, "base64").equals(data)).toBe(true);
        expect(d.size).toBe(data.length);
        expect(d.mime).toBe(mime);
      }
      // atomic write leaves no temp file behind
      expect(readdirSync(dirname(join(b.root, path))).filter((f) => f.includes(".tmp-"))).toEqual(
        [],
      );
    } finally {
      b.cleanup();
    }
  });

  it("a bare filename lands in the vault's configured attachment folder", async () => {
    const b = boot({ files: { ".obsidian/app.json": '{"attachmentFolderPath":"assets/img"}' } });
    try {
      const w = await b.call("write_attachment", {
        vault: "test",
        path: "pic.png",
        content: b64(PNG),
      });
      expect(w.ok).toBe(true);
      if (w.ok) expect((w.data as { path: string }).path).toBe("assets/img/pic.png");
      expect(b.bytes("assets/img/pic.png").equals(PNG)).toBe(true);
      expect(b.exists("pic.png")).toBe(false);
      // an explicit folder is honoured as given
      const w2 = await b.call("write_attachment", {
        vault: "test",
        path: "elsewhere/pic.png",
        content: b64(PNG),
      });
      expect(w2.ok).toBe(true);
      expect(b.exists("elsewhere/pic.png")).toBe(true);
    } finally {
      b.cleanup();
    }
  });

  it("a bare filename with no configured attachment folder lands at the vault root", async () => {
    const b = boot();
    try {
      const w = await b.call("write_attachment", {
        vault: "test",
        path: "pic.png",
        content: b64(PNG),
      });
      expect(w.ok).toBe(true);
      expect(b.exists("pic.png")).toBe(true);
    } finally {
      b.cleanup();
    }
  });

  it("an explicit mime_type that matches the extension is accepted; a mismatch is refused", async () => {
    const b = boot();
    try {
      const ok = await b.call("write_attachment", {
        vault: "test",
        path: "a.png",
        content: b64(PNG),
        mime_type: "image/png",
      });
      expect(ok.ok).toBe(true);
      const bad = await b.call("write_attachment", {
        vault: "test",
        path: "b.png",
        content: b64(PNG),
        mime_type: "application/pdf",
      });
      expect(code(bad)).toBe("invalid_input");
      expect(b.exists("b.png")).toBe(false);
    } finally {
      b.cleanup();
    }
  });
});

describe("write_attachment: overwrite", () => {
  const input = { vault: "test", path: "a.png", content: b64(PNG), overwrite: true };

  it("overwrite:false (default) refuses an existing file and leaves it untouched", async () => {
    const b = boot({ files: { "a.png": "OLD" } });
    try {
      const r = await b.call("write_attachment", {
        vault: "test",
        path: "a.png",
        content: b64(PNG),
      });
      expect(code(r)).toBe("note_exists");
      expect(b.bytes("a.png").toString()).toBe("OLD");
    } finally {
      b.cleanup();
    }
  });

  it("overwrite:true demands confirmation, then replaces and soft-deletes the prior bytes", async () => {
    const b = boot({ files: { "a.png": "OLD" } });
    try {
      const need = await b.call("write_attachment", input);
      expect(b.bytes("a.png").toString()).toBe("OLD");
      const ok = await b.call("write_attachment", input, {
        elicitToken: mint(b, "write_attachment", hashOf(need)),
      });
      expect(ok.ok).toBe(true);
      if (ok.ok)
        expect(ok.data).toMatchObject({
          created: false,
          overwritten: true,
          trashed_prev_to: ".trash/a.png",
        });
      expect(b.bytes("a.png").equals(PNG)).toBe(true);
      expect(b.bytes(".trash/a.png").toString()).toBe("OLD");
    } finally {
      b.cleanup();
    }
  });

  it("overwrite:true onto a path that does not exist needs no confirmation", async () => {
    const b = boot();
    try {
      const r = await b.call("write_attachment", input);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data).toMatchObject({ created: true, overwritten: false });
    } finally {
      b.cleanup();
    }
  });

  it("a target changed after the request was raised is replay_drift; nothing is written", async () => {
    const b = boot({ files: { "a.png": "OLD" } });
    try {
      const need = await b.call("write_attachment", input);
      const token = mint(b, "write_attachment", hashOf(need));
      b.put("a.png", "CHANGED MEANWHILE");
      const r = await b.call("write_attachment", input, { elicitToken: token });
      expect(code(r)).toBe("replay_drift");
      expect(b.bytes("a.png").toString()).toBe("CHANGED MEANWHILE");
      expect(b.exists(".trash/a.png")).toBe(false);
    } finally {
      b.cleanup();
    }
  });

  it("drift is bound to the RESOLVED target, not the bare name (default attachment folder)", async () => {
    const b = boot({
      files: { ".obsidian/app.json": '{"attachmentFolderPath":"assets"}', "assets/a.png": "OLD" },
    });
    try {
      const bare = { vault: "test", path: "a.png", content: b64(PNG), overwrite: true };
      const need = await b.call("write_attachment", bare);
      const token = mint(b, "write_attachment", hashOf(need));
      b.put("assets/a.png", "CHANGED MEANWHILE");
      expect(code(await b.call("write_attachment", bare, { elicitToken: token }))).toBe(
        "replay_drift",
      );
      expect(b.bytes("assets/a.png").toString()).toBe("CHANGED MEANWHILE");
    } finally {
      b.cleanup();
    }
  });

  it("control: an unchanged target redeems the token", async () => {
    const b = boot({ files: { "a.png": "OLD" } });
    try {
      const need = await b.call("write_attachment", input);
      const r = await b.call("write_attachment", input, {
        elicitToken: mint(b, "write_attachment", hashOf(need)),
      });
      expect(r.ok).toBe(true);
    } finally {
      b.cleanup();
    }
  });
});

describe("write_attachment: ACL and scopes", () => {
  it("a path outside the write whitelist is acl_denied (central stage and handler)", async () => {
    const b = boot();
    try {
      const r = await b.call(
        "write_attachment",
        { vault: "locked", path: "elsewhere/a.png", content: b64(PNG) },
        { vaultId: "locked" },
      );
      expect(code(r)).toBe("acl_denied");
      expect(b.exists("elsewhere/a.png", b.otherRoot)).toBe(false);
    } finally {
      b.cleanup();
    }
  });

  it("the per-vault override applies: same call is denied on one vault, allowed on the other", async () => {
    const b = boot();
    try {
      const args = { path: "only-here/a.png", content: b64(PNG) };
      expect(
        (await b.call("write_attachment", { vault: "locked", ...args }, { vaultId: "locked" })).ok,
      ).toBe(true);
      expect(b.exists("only-here/a.png", b.otherRoot)).toBe(true);
      const denied = await b.call(
        "write_attachment",
        { vault: "locked", path: "elsewhere/a.png", content: b64(PNG) },
        { vaultId: "locked" },
      );
      expect(code(denied)).toBe("acl_denied");
      // the open vault has no whitelist
      const open = await b.call("write_attachment", {
        vault: "test",
        path: "elsewhere/a.png",
        content: b64(PNG),
      });
      expect(open.ok).toBe(true);
    } finally {
      b.cleanup();
    }
  });

  it("a bare filename is ACL-checked against the RESOLVED attachment folder", async () => {
    const b = boot();
    try {
      mkdirSync(join(b.otherRoot, ".obsidian"), { recursive: true });
      writeFileSync(
        join(b.otherRoot, ".obsidian", "app.json"),
        '{"attachmentFolderPath":"only-here/att"}',
      );
      // root-level bare name would be outside the whitelist; the resolved folder is inside it
      const r = await b.call(
        "write_attachment",
        { vault: "locked", path: "a.png", content: b64(PNG) },
        { vaultId: "locked" },
      );
      expect(r.ok).toBe(true);
      expect(b.exists("only-here/att/a.png", b.otherRoot)).toBe(true);
    } finally {
      b.cleanup();
    }
  });

  it("a caller without write:attachments is refused", async () => {
    const b = boot();
    try {
      const r = await b.call(
        "write_attachment",
        { vault: "test", path: "a.png", content: b64(PNG) },
        { grantedScopes: new Set(["read:attachments", "write:notes"]) },
      );
      expect(code(r)).toBe("forbidden");
      expect(b.exists("a.png")).toBe(false);
    } finally {
      b.cleanup();
    }
  });

  it("a read-only ACL refuses the write", async () => {
    const b = boot();
    try {
      const r = await b.call(
        "write_attachment",
        { vault: "ro", path: "a.png", content: b64(PNG) },
        { vaultId: "ro" },
      );
      expect(["read_only", "read_only_mode", "forbidden"]).toContain(code(r));
      expect(b.exists("a.png", b.roRoot)).toBe(false);
    } finally {
      b.cleanup();
    }
  });
});

describe("write_attachment: path safety", () => {
  it.each(["../escape.png", "a/../../escape.png", "/abs/escape.png"])(
    "traversal / absolute path %s is refused",
    async (path) => {
      const b = boot();
      try {
        const r = await b.call("write_attachment", { vault: "test", path, content: b64(PNG) });
        expect(r.ok).toBe(false);
        expect(existsSync(join(b.root, "..", "escape.png"))).toBe(false);
      } finally {
        b.cleanup();
      }
    },
  );

  it("a symlinked directory pointing outside the vault is refused and nothing lands outside", async () => {
    const b = boot();
    try {
      symlinkSync(b.outside, join(b.root, "link"));
      const r = await b.call("write_attachment", {
        vault: "test",
        path: "link/a.png",
        content: b64(PNG),
      });
      expect(r.ok).toBe(false);
      expect(readdirSync(b.outside)).toEqual([]);
    } finally {
      b.cleanup();
    }
  });

  it("a symlink at the target itself is refused, even when it points inside the vault", async () => {
    const b = boot({ files: { "real.png": "REAL" } });
    try {
      symlinkSync(join(b.root, "real.png"), join(b.root, "alias.png"));
      const r = await b.call("write_attachment", {
        vault: "test",
        path: "alias.png",
        content: b64(PNG),
        overwrite: true,
      });
      expect(r.ok).toBe(false);
      expect(b.bytes("real.png").toString()).toBe("REAL");
    } finally {
      b.cleanup();
    }
  });

  it("a symlink at the target pointing OUTSIDE the vault is refused; the outside file is intact", async () => {
    const b = boot();
    try {
      writeFileSync(join(b.outside, "secret.png"), "SECRET");
      symlinkSync(join(b.outside, "secret.png"), join(b.root, "alias.png"));
      const r = await b.call("write_attachment", {
        vault: "test",
        path: "alias.png",
        content: b64(PNG),
        overwrite: true,
      });
      expect(r.ok).toBe(false);
      expect(readFileSync(join(b.outside, "secret.png"), "utf8")).toBe("SECRET");
    } finally {
      b.cleanup();
    }
  });

  it.each(["note.md", "board.canvas", "table.base", "NOTE.MD"])(
    "%s is refused: those formats have their own tools",
    async (path) => {
      const b = boot();
      try {
        const r = await b.call("write_attachment", {
          vault: "test",
          path,
          content: b64(Buffer.from("# hi")),
        });
        expect(code(r)).toBe("invalid_input");
        expect(b.exists(path)).toBe(false);
      } finally {
        b.cleanup();
      }
    },
  );

  it.each(["noext", "weird.exe", "archive.zip"])(
    "%s (not on the attachment allowlist) is refused",
    async (path) => {
      const b = boot();
      try {
        const r = await b.call("write_attachment", { vault: "test", path, content: b64(PNG) });
        expect(code(r)).toBe("invalid_input");
        expect(b.exists(path)).toBe(false);
      } finally {
        b.cleanup();
      }
    },
  );

  it.each([
    ".obsidian/plugins/x/evil.png",
    ".git/objects/x.png",
    ".trash/x.png",
    ".OBSIDIAN/x.png",
  ])("default-denied path %s is refused even with no ACL", async (path) => {
    const b = boot();
    try {
      for (const over of [{}, { acl: undefined }]) {
        const r = await b.call(
          "write_attachment",
          { vault: "test", path, content: b64(PNG) },
          over as Partial<CallerContext>,
        );
        expect(code(r)).toBe("acl_denied");
      }
      expect(b.exists(path)).toBe(false);
    } finally {
      b.cleanup();
    }
  });

  it("the handler itself refuses a control directory when no ACL reaches it", () => {
    const b = boot();
    try {
      const reg = new ToolRegistry();
      registerM3Tools(reg, { vaultRegistry: new VaultRegistry([{ id: "test", path: b.root }]) });
      const handler = reg.list().find((t) => t.name === "write_attachment")?.handler;
      const noAcl = { ...b.ctx(), acl: undefined } as unknown as CallerContext;
      const input = { vault: "test", path: ".obsidian/x.png", content: b64(PNG), overwrite: false };
      expect(() => handler?.({ ...input, options: { create_dirs: true } }, noAcl)).toThrow(
        /protected vault directory/,
      );
      expect(b.exists(".obsidian/x.png")).toBe(false);
    } finally {
      b.cleanup();
    }
  });

  it("a folder at the target path is refused", async () => {
    const b = boot({ files: { "dir.png/inner.txt": "x" } });
    try {
      const r = await b.call("write_attachment", {
        vault: "test",
        path: "dir.png",
        content: b64(PNG),
        overwrite: true,
      });
      expect(code(r)).toBe("invalid_input");
    } finally {
      b.cleanup();
    }
  });

  it("create_dirs:false refuses a missing parent", async () => {
    const b = boot();
    try {
      const r = await b.call("write_attachment", {
        vault: "test",
        path: "nope/a.png",
        content: b64(PNG),
        options: { create_dirs: false },
      });
      expect(r.ok).toBe(false);
      expect(b.exists("nope")).toBe(false);
    } finally {
      b.cleanup();
    }
  });
});

describe("write_attachment: size cap and base64 validation", () => {
  it("accepts exactly the cap and refuses one byte over, before decoding", async () => {
    const cap = 1000;
    const b = boot({ maxAttachmentBytes: cap });
    try {
      const at = await b.call("write_attachment", {
        vault: "test",
        path: "at.png",
        content: b64(Buffer.alloc(cap, 7)),
      });
      expect(at.ok).toBe(true);
      expect(b.bytes("at.png").length).toBe(cap);

      const from = vi.spyOn(Buffer, "from");
      try {
        const over = await b.call("write_attachment", {
          vault: "test",
          path: "over.png",
          content: b64(Buffer.alloc(cap + 1, 7)),
        });
        expect(code(over)).toBe("invalid_input");
        if (!over.ok) expect(over.error.details).toMatchObject({ max_bytes: cap });
        // the base64 payload is never decoded on the refusal path
        expect(from.mock.calls.filter((c) => (c as unknown[])[1] === "base64")).toEqual([]);
      } finally {
        from.mockRestore();
      }
      expect(b.exists("over.png")).toBe(false);
    } finally {
      b.cleanup();
    }
  });

  it("the default cap is 25 MB decoded", async () => {
    const b = boot();
    try {
      const over = await b.call("write_attachment", {
        vault: "test",
        path: "big.png",
        content: "A".repeat(Math.ceil(((25_000_000 + 1) * 4) / 3) + 4),
      });
      expect(code(over)).toBe("invalid_input");
      if (!over.ok) expect(over.error.details).toMatchObject({ max_bytes: 25_000_000 });
      expect(b.exists("big.png")).toBe(false);
    } finally {
      b.cleanup();
    }
  });

  it.each([
    ["non-alphabet characters", "@@@@"],
    ["whitespace inside", "iVBO Rw0K"],
    ["newline inside", "iVBORw0K\nGgo="],
    ["url-safe alphabet", "-_-_"],
    ["length not a multiple of 4", "iVBOR"],
    ["padding in the middle", "iV==Rw0K"],
    ["too much padding", "iVBO===="],
    ["non-canonical trailing bits", "QR=="],
    ["a data: URI", `data:image/png;base64,${b64(PNG)}`],
  ])("invalid base64 (%s) is refused and nothing is written", async (_n, content) => {
    const b = boot();
    try {
      const r = await b.call("write_attachment", { vault: "test", path: "a.png", content });
      expect(code(r)).toBe("invalid_input");
      expect(b.exists("a.png")).toBe(false);
    } finally {
      b.cleanup();
    }
  });

  it("padding forms round trip (0, 1 and 2 pad chars)", async () => {
    const b = boot();
    try {
      for (const n of [3, 4, 5]) {
        const data = Buffer.from(Array.from({ length: n }, (_, i) => 250 - i));
        const r = await b.call("write_attachment", {
          vault: "test",
          path: `p${n}.png`,
          content: b64(data),
        });
        expect(r.ok).toBe(true);
        expect(b.bytes(`p${n}.png`).equals(data)).toBe(true);
      }
    } finally {
      b.cleanup();
    }
  });
});

describe("write_attachment: registration and governance", () => {
  it("declares write scope, pathAcl, vaultArg, idempotency and a conditional-destructive hint", () => {
    const b = boot();
    try {
      const reg = new ToolRegistry();
      registerM3Tools(reg, { vaultRegistry: new VaultRegistry([{ id: "x", path: b.root }]) });
      const tool = reg.list().find((t) => t.name === "write_attachment");
      expect(tool).toBeDefined();
      expect(tool?.requiredScopes).toEqual(["write:attachments"]);
      expect(tool?.domain).toBe("attachments");
      expect(tool?.vaultArg).toBe("vault");
      expect(tool?.acceptsIdempotencyKey).toBe(true);
      expect(tool?.conditionallyDestructive).toBe(true);
      expect(tool?.pathAcl?.({ path: "a/b.png", vault: "x" })).toEqual([
        { op: "write", path: "a/b.png" },
      ]);
    } finally {
      b.cleanup();
    }
  });

  it("a successful write is audited in event_log", async () => {
    const b = boot();
    try {
      await b.call("write_attachment", { vault: "test", path: "a.png", content: b64(PNG) });
      const rows = b.db
        .prepare("SELECT tool_name, status FROM event_log WHERE tool_name = 'write_attachment'")
        .all() as Array<{ tool_name: string; status: string }>;
      expect(rows.length).toBe(1);
    } finally {
      b.cleanup();
    }
  });
});
