// get / update / append / patch / delete _active_file. The bridge is the fake companion transport
// answering GET /files/active with a path the test controls (there is no live-Obsidian harness in
// this repo; test/live-companion.test.ts is the opt-in live smoke and does not cover these tools,
// so a live check that the route answers from a real workspace remains manual). Everything the
// tools do to the note goes through the REAL read_note / write_note / append_note / patch_note /
// delete_note handlers (M1 is registered beside M4), so these tests pin the resolution and binding
// seams and only spot-check that the delegate's own behavior (CAS, snapshot, memoryDefense, the
// overwrite confirmation) is the one that runs.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { type AclConfigT, FolderAcl } from "../src/acl";
import type { FakeRequestInfo, FakeRoute } from "../src/bridge";
import { CapabilityCache, createBridgeClient, fakeBridgeTransport } from "../src/bridge";
import { provisionCacheDb } from "../src/db/provision";
import { elicitVerifier, issueElicitToken } from "../src/elicit";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { registerM1Tools } from "../src/tools/m1";
import { registerM4Tools } from "../src/tools/m4";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { rmTemp } from "./tmp";

const ACTIVE = "GET /obsidian-tc/v1/files/active";
const active = (path: string | null, extension?: string | null): FakeRoute => ({
  body: {
    ok: true,
    result: { path, extension: extension ?? (path ? path.split(".").pop() : null) },
  },
});

interface Harness {
  roots: { test: string; other: string };
  registry: ToolRegistry;
  db: ReturnType<typeof openMemoryDb>;
  routes: Record<string, FakeRoute>;
  requests: FakeRequestInfo[];
  /** Point the (fake) live session at `path`, or at nothing. */
  focus(path: string | null, extension?: string | null): void;
  call(
    name: string,
    input: Record<string, unknown>,
    over?: Partial<CallerContext>,
  ): Promise<ToolResult>;
  /** Raise the confirmation, mint the token an operator would, redeem it: mirrors the real flow. */
  confirm(toolName: string, argsHash: string): CallerContext["elicitToken"];
  read(rel: string, vault?: string): string;
  has(rel: string, vault?: string): boolean;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function harness(
  opts: {
    files?: Record<string, string>;
    otherFiles?: Record<string, string>;
    acl?: Partial<AclConfigT>;
    otherAcl?: Partial<AclConfigT>;
    snapshot?: Parameters<CapabilityCache["set"]>[1];
    memoryDefense?: { mode: "off" | "redact" | "block"; pii: boolean };
  } = {},
): Harness {
  const mk = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), "obtc-active-"));
    cleanups.push(() => rmTemp(root));
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    return root;
  };
  const roots = { test: mk(opts.files ?? {}), other: mk(opts.otherFiles ?? {}) };
  const vaultRegistry = new VaultRegistry([
    { id: "test", path: roots.test },
    { id: "other", path: roots.other },
  ]);
  const db = openMemoryDb();
  provisionCacheDb(db);
  const acls: Record<string, FolderAcl> = {
    test: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [], ...opts.acl }),
    other: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [], ...opts.otherAcl }),
  };
  const routes: Record<string, FakeRoute> = { [ACTIVE]: active(null) };
  const requests: FakeRequestInfo[] = [];
  const client = createBridgeClient({
    baseUrl: "http://127.0.0.1:27124",
    apiKey: "k",
    fetchFn: fakeBridgeTransport({ routes, onRequest: (i) => requests.push(i) }),
  });
  const capabilities = new CapabilityCache();
  for (const id of ["test", "other"])
    capabilities.set(id, opts.snapshot ?? { companion: "reachable", plugins: {} });

  const registry = new ToolRegistry({
    verifyElicit: elicitVerifier,
    rootResolver: (id) => roots[id as "test" | "other"],
    aclResolver: (id) => acls[id],
  });
  registerM1Tools(registry, {
    vaultRegistry,
    version: "test",
    startedAt: 0,
    embeddings: { provider: "none", model: "none" },
    snapshots: { enabled: true, retention: 10 },
    ...(opts.memoryDefense ? { memoryDefense: () => opts.memoryDefense as never } : {}),
  });
  registerM4Tools(registry, { vaultRegistry, capabilities, bridgeFor: () => client });

  const ctx = (over: Partial<CallerContext> = {}): CallerContext => ({
    caller: "test",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "test",
    db,
    acl: acls.test,
    ...over,
  });
  return {
    roots,
    registry,
    db,
    routes,
    requests,
    focus: (path, extension) => {
      routes[ACTIVE] = active(path, extension);
    },
    call: (name, input, over) => registry.dispatch(name, input, ctx(over)),
    confirm: (toolName, argsHash) =>
      issueElicitToken(db, {
        vaultId: "test",
        toolName,
        argsHash,
        caller: "test",
      }),
    read: (rel, vault = "test") =>
      readFileSync(join(roots[vault as "test" | "other"], rel), "utf8"),
    has: (rel, vault = "test") => existsSync(join(roots[vault as "test" | "other"], rel)),
  };
}

const okData = <T = Record<string, unknown>>(r: ToolResult): T => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.data as T;
};
const errOf = (r: ToolResult) => {
  if (r.ok) throw new Error("expected an error result");
  return r.error;
};
const argsHashOf = (r: ToolResult): string => (errOf(r).details as { args_hash: string }).args_hash;

const NOTE_A = "# A\n\nalpha\n\n## Todo\n\n- one\n";
const NOTE_B = "# B\n\nbravo\n";

describe("get_active_file", () => {
  it("reads the active note through read_note's handler and reports its type", async () => {
    const h = harness({ files: { "Notes/a.md": NOTE_A } });
    h.focus("Notes/a.md");
    const d = okData<Record<string, unknown>>(await h.call("get_active_file", { vault: "test" }));
    expect(d).toMatchObject({
      vault: "test",
      path: "Notes/a.md",
      content: NOTE_A,
      extension: "md",
      is_markdown: true,
    });
    expect(d.content_hash).toEqual(expect.any(String));
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.method).toBe("GET");
    expect(new URL(h.requests[0]?.url ?? "").pathname).toBe("/obsidian-tc/v1/files/active");
  });

  it("passes an anchor through to read_note's section read", async () => {
    const h = harness({ files: { "Notes/a.md": NOTE_A } });
    h.focus("Notes/a.md");
    const d = okData<{ section?: { text: string } }>(
      await h.call("get_active_file", {
        vault: "test",
        anchor: { type: "heading", heading: "Todo" },
      }),
    );
    expect(d.section?.text).toContain("- one");
  });

  it("answers metadata only for a non-markdown active file", async () => {
    const h = harness({ files: { "Boards/plan.canvas": "{}" } });
    h.focus("Boards/plan.canvas");
    const d = okData<Record<string, unknown>>(await h.call("get_active_file", { vault: "test" }));
    expect(d).toMatchObject({
      path: "Boards/plan.canvas",
      extension: "canvas",
      is_markdown: false,
    });
    expect(d.stat).toMatchObject({ size: 2 });
    expect(d.content).toBeUndefined();
  });

  it("does not accept a path: the target is never caller-chosen", async () => {
    const h = harness({ files: { "Notes/a.md": NOTE_A } });
    h.focus("Notes/a.md");
    const r = await h.call("get_active_file", { vault: "test", path: "Notes/other.md" });
    expect(errOf(r).code).toBe("validation_error");
    expect(h.requests).toHaveLength(0);
  });
});

describe("no active file / bridge unavailable: typed errors, never a default path", () => {
  it("no active file -> note_not_found with reason and hint, for every tool", async () => {
    const h = harness({ files: { "Notes/a.md": NOTE_A } });
    h.focus(null);
    const inputs: Array<[string, Record<string, unknown>]> = [
      ["get_active_file", { vault: "test" }],
      ["update_active_file", { vault: "test", content: "x" }],
      ["append_active_file", { vault: "test", content: "x" }],
      [
        "patch_active_file",
        { vault: "test", operation: "append", anchor: { type: "frontmatter" }, content: "x" },
      ],
      ["delete_active_file", { vault: "test" }],
    ];
    for (const [name, input] of inputs) {
      const e = errOf(await h.call(name, input));
      expect(e.code, name).toBe("note_not_found");
      expect(e.details, name).toMatchObject({ reason: "no_active_file" });
      expect((e.details as { hint?: string }).hint, name).toEqual(expect.any(String));
    }
    expect(h.read("Notes/a.md")).toBe(NOTE_A);
  });

  it("bridge down (network failure) -> plugin_unreachable with a hint; nothing is touched", async () => {
    const h = harness({ files: { "Notes/a.md": NOTE_A } });
    h.routes[ACTIVE] = { networkError: true };
    const e = errOf(await h.call("update_active_file", { vault: "test", content: "x" }));
    expect(e.code).toBe("plugin_unreachable");
    expect((e.details as { hint?: string }).hint).toMatch(/Obsidian/);
    expect(h.read("Notes/a.md")).toBe(NOTE_A);
  });

  it("companion missing -> plugin_unreachable before any request is made", async () => {
    const h = harness({ snapshot: { companion: "missing", plugins: {} } });
    const e = errOf(await h.call("get_active_file", { vault: "test" }));
    expect(e.code).toBe("plugin_unreachable");
    expect(h.requests).toHaveLength(0);
  });

  it("an older companion without the route (404) -> a hint to update the companion", async () => {
    const h = harness();
    h.routes[ACTIVE] = { status: 404, body: { not: "an envelope" } };
    const e = errOf(await h.call("get_active_file", { vault: "test" }));
    expect(e.code).toBe("plugin_unreachable");
    expect((e.details as { hint?: string }).hint).toMatch(/update the companion/i);
  });

  it("an unusable payload or path from the companion is refused, not trusted", async () => {
    const h = harness({ files: { "Notes/a.md": NOTE_A } });
    h.routes[ACTIVE] = { body: { ok: true, result: { nope: 1 } } };
    expect(errOf(await h.call("get_active_file", { vault: "test" })).code).toBe(
      "plugin_unreachable",
    );
    for (const bad of ["../outside.md", "/etc/passwd", "a/../../b.md"]) {
      h.focus(bad);
      const e = errOf(await h.call("update_active_file", { vault: "test", content: "x" }));
      expect(e.code, bad).toBe("invalid_input");
    }
  });
});

describe("update_active_file", () => {
  it("overwrites the active note through write_note (CAS hash, snapshot) after the confirmation", async () => {
    const h = harness({ files: { "Notes/a.md": NOTE_A } });
    h.focus("Notes/a.md");
    const first = await h.call("update_active_file", { vault: "test", content: "# New\n" });
    // Overwriting a non-empty note is write_note's own conditional confirmation.
    expect(errOf(first).code).toBe("elicit_required");
    expect(errOf(first).details).toMatchObject({ tool: "write_note", path: "Notes/a.md" });
    expect(h.read("Notes/a.md")).toBe(NOTE_A);

    const token = h.confirm("write_note", argsHashOf(first));
    const d = okData<Record<string, unknown>>(
      await h.call(
        "update_active_file",
        { vault: "test", content: "# New\n" },
        { elicitToken: token },
      ),
    );
    expect(d).toMatchObject({ path: "Notes/a.md", mode_used: "overwrite", created: false });
    expect(h.read("Notes/a.md")).toBe("# New\n");
    // write_note's snapshot-on-overwrite ran: the previous body is recoverable.
    const snaps = okData<{ snapshots: unknown[] }>(
      await h.call("list_snapshots", { vault: "test", path: "Notes/a.md" }),
    );
    expect(snaps.snapshots.length).toBeGreaterThan(0);
  });

  it("overwrites an EMPTY active note without a confirmation", async () => {
    const h = harness({ files: { "Notes/empty.md": "" } });
    h.focus("Notes/empty.md");
    okData(await h.call("update_active_file", { vault: "test", content: "hello" }));
    expect(h.read("Notes/empty.md")).toBe("hello");
  });

  it("keeps write_note's prev_hash compare-and-swap", async () => {
    const h = harness({ files: { "Notes/a.md": NOTE_A } });
    h.focus("Notes/a.md");
    const r = await h.call("update_active_file", {
      vault: "test",
      content: "x",
      prev_hash: "0".repeat(64),
    });
    // The CAS check precedes the confirmation in write_note, so this is refused outright.
    expect(errOf(r).code).toBe("concurrent_modification");
    expect(h.read("Notes/a.md")).toBe(NOTE_A);
  });

  it("applies the vault's memoryDefense to the new content", async () => {
    const h = harness({
      files: { "Notes/empty.md": "" },
      memoryDefense: { mode: "block", pii: true },
    });
    h.focus("Notes/empty.md");
    const pan = ["4234", "5678", "9012", "3449"].join(" ");
    const r = await h.call("update_active_file", { vault: "test", content: `card ${pan}` });
    expect(r.ok).toBe(false);
    expect(h.read("Notes/empty.md")).toBe("");
  });

  it("does not accept mode (always overwrite) or path", async () => {
    const h = harness({ files: { "Notes/a.md": NOTE_A } });
    h.focus("Notes/a.md");
    for (const extra of [{ mode: "create" }, { path: "Notes/b.md" }]) {
      const r = await h.call("update_active_file", { vault: "test", content: "x", ...extra });
      expect(errOf(r).code).toBe("validation_error");
    }
  });
});

describe("append_active_file / patch_active_file", () => {
  it("appends to the active note through append_note", async () => {
    const h = harness({ files: { "Notes/a.md": NOTE_A } });
    h.focus("Notes/a.md");
    const d = okData<Record<string, unknown>>(
      await h.call("append_active_file", { vault: "test", content: "- two" }),
    );
    expect(d).toMatchObject({ path: "Notes/a.md", created: false });
    expect(h.read("Notes/a.md")).toBe(`${NOTE_A}- two`);
  });

  it("append never creates: create_if_missing is not accepted", async () => {
    const h = harness({ files: { "Notes/a.md": NOTE_A } });
    h.focus("Notes/a.md");
    const r = await h.call("append_active_file", {
      vault: "test",
      content: "x",
      create_if_missing: true,
    });
    expect(errOf(r).code).toBe("validation_error");
  });

  it("patches a heading section of the active note through patch_note", async () => {
    const h = harness({ files: { "Notes/a.md": NOTE_A } });
    h.focus("Notes/a.md");
    const d = okData<Record<string, unknown>>(
      await h.call("patch_active_file", {
        vault: "test",
        operation: "append",
        anchor: { type: "heading", heading: "Todo" },
        content: "- two",
      }),
    );
    expect(d).toMatchObject({ path: "Notes/a.md", operation: "append" });
    const after = h.read("Notes/a.md");
    expect(after.indexOf("- two")).toBeGreaterThan(after.indexOf("- one"));
  });

  it("enforces patch_note's cross-field rules at the schema (replace_text needs old_string)", async () => {
    const h = harness({ files: { "Notes/a.md": NOTE_A } });
    h.focus("Notes/a.md");
    const r = await h.call("patch_active_file", {
      vault: "test",
      operation: "replace_text",
      anchor: { type: "heading", heading: "Todo" },
      new_string: "x",
    });
    expect(errOf(r).code).toBe("validation_error");
    expect(h.requests).toHaveLength(0);
  });
});

describe("response_format (GH #1027): the active-file tools hand it to their delegates", () => {
  const PATCH = {
    vault: "test",
    operation: "append",
    anchor: { type: "heading", heading: "Todo" },
    content: "- two",
  };
  const keys = (o: unknown): string[] => Object.keys(o as object).sort();

  it("patch_active_file: unset and detailed carry patch_note's full ack; concise is the short one", async () => {
    const run = async (extra: Record<string, unknown>) => {
      const h = harness({ files: { "Notes/a.md": NOTE_A } });
      h.focus("Notes/a.md");
      return okData(await h.call("patch_active_file", { ...PATCH, ...extra }));
    };
    const unset = await run({});
    const detailed = await run({ response_format: "detailed" });
    expect(keys(detailed)).toEqual(keys(unset));
    expect(keys(unset)).toEqual(
      expect.arrayContaining(["anchor", "operation", "prev_hash", "content_hash", "path", "vault"]),
    );
    const concise = await run({ response_format: "concise" });
    expect(keys(concise)).toEqual(["content_hash", "path", "vault"]);
    expect(concise.path).toBe("Notes/a.md");
    expect(concise.content_hash).toBe(unset.content_hash);
    // The legacy alias is accepted on the same input.
    expect(keys(await run({ verbosity: "terse" }))).toEqual(["content_hash", "path", "vault"]);
  });

  it("patch_active_file still edits the note and still reports a blast radius when concise", async () => {
    const h = harness({ files: { "Notes/a.md": NOTE_A } });
    h.focus("Notes/a.md");
    const d = okData(
      await h.call("patch_active_file", {
        vault: "test",
        operation: "replace_text",
        anchor: { type: "heading", heading: "Todo" },
        old_string: "- one",
        new_string: "- uno",
        response_format: "concise",
      }),
    );
    expect(keys(d)).toEqual(["bytes_removed", "content_hash", "lines_removed", "path", "vault"]);
    expect(h.read("Notes/a.md")).toContain("- uno");
  });

  it("get_active_file: concise is read_note's body-only read plus the active-file fields", async () => {
    const files = { "Notes/a.md": `---\ntitle: A\n---\n${NOTE_A}` };
    const h = harness({ files });
    h.focus("Notes/a.md");
    const full = okData(await h.call("get_active_file", { vault: "test" }));
    expect(full.content).toBe(files["Notes/a.md"]);
    const d = okData(
      await h.call("get_active_file", { vault: "test", response_format: "concise" }),
    );
    expect(keys(d)).toEqual(["body", "content_hash", "extension", "is_markdown", "path", "vault"]);
    expect(d.body).toBe(NOTE_A);
    expect(d.content_hash).toBe(full.content_hash);
  });

  it("get_active_file: a non-markdown active file answers the same metadata in both formats", async () => {
    const h = harness({ files: { "Boards/plan.canvas": "{}" } });
    h.focus("Boards/plan.canvas");
    const full = okData(await h.call("get_active_file", { vault: "test" }));
    const d = okData(
      await h.call("get_active_file", { vault: "test", response_format: "concise" }),
    );
    expect(d).toEqual(full);
  });

  it("append_active_file and update_active_file already inherit the parameter from their delegates", async () => {
    const h = harness({ files: { "Notes/a.md": NOTE_A } });
    h.focus("Notes/a.md");
    const ap = okData(
      await h.call("append_active_file", {
        vault: "test",
        content: "- two",
        response_format: "concise",
      }),
    );
    expect(keys(ap)).toEqual(["content_hash", "path", "vault"]);
  });
});

describe("delete_active_file", () => {
  it("is destructive: no token -> elicit_required, note untouched; with the token it is trashed", async () => {
    const h = harness({ files: { "Notes/a.md": NOTE_A } });
    h.focus("Notes/a.md");
    const first = await h.call("delete_active_file", { vault: "test" });
    expect(errOf(first).code).toBe("elicit_required");
    expect(h.has("Notes/a.md")).toBe(true);

    const token = h.confirm("delete_active_file", argsHashOf(first));
    const d = okData<Record<string, unknown>>(
      await h.call("delete_active_file", { vault: "test" }, { elicitToken: token }),
    );
    expect(d).toMatchObject({ path: "Notes/a.md", deleted: true, permanent: false });
    expect(h.has("Notes/a.md")).toBe(false);
  });
});

describe("focus switch: a confirmation is bound to the note it was raised for", () => {
  it("delete: a token minted while A was active does not delete B", async () => {
    const h = harness({ files: { "Notes/a.md": NOTE_A, "Notes/b.md": NOTE_B } });
    h.focus("Notes/a.md");
    const forA = await h.call("delete_active_file", { vault: "test" });
    const hashA = argsHashOf(forA);

    // The user clicks over to B before the operator approves.
    h.focus("Notes/b.md");
    const onB = await h.call(
      "delete_active_file",
      { vault: "test" },
      { elicitToken: h.confirm("delete_active_file", hashA) },
    );
    expect(errOf(onB).code).toBe("elicit_required");
    expect(argsHashOf(onB)).not.toBe(hashA);
    expect(h.has("Notes/b.md")).toBe(true);
    expect(h.has("Notes/a.md")).toBe(true);

    // Back on A, the approval the human gave for A still lands on A, and only A.
    h.focus("Notes/a.md");
    okData(
      await h.call(
        "delete_active_file",
        { vault: "test" },
        { elicitToken: h.confirm("delete_active_file", hashA) },
      ),
    );
    expect(h.has("Notes/a.md")).toBe(false);
    expect(h.has("Notes/b.md")).toBe(true);
  });

  it("update: a token minted while A was active does not overwrite B", async () => {
    const h = harness({ files: { "Notes/a.md": NOTE_A, "Notes/b.md": NOTE_B } });
    h.focus("Notes/a.md");
    const forA = await h.call("update_active_file", { vault: "test", content: "# clobber\n" });
    const hashA = argsHashOf(forA);

    h.focus("Notes/b.md");
    const onB = await h.call(
      "update_active_file",
      { vault: "test", content: "# clobber\n" },
      { elicitToken: h.confirm("write_note", hashA) },
    );
    expect(errOf(onB).code).toBe("elicit_required");
    expect(errOf(onB).details).toMatchObject({ path: "Notes/b.md" });
    expect(argsHashOf(onB)).not.toBe(hashA);
    expect(h.read("Notes/b.md")).toBe(NOTE_B);
    expect(h.read("Notes/a.md")).toBe(NOTE_A);
  });

  it("the same note edited after the request is replay_drift, not a silent overwrite", async () => {
    const h = harness({ files: { "Notes/a.md": NOTE_A } });
    h.focus("Notes/a.md");
    const forA = await h.call("update_active_file", { vault: "test", content: "# clobber\n" });
    const token = h.confirm("write_note", argsHashOf(forA));
    writeFileSync(join(h.roots.test, "Notes/a.md"), `${NOTE_A}\nedited elsewhere\n`);
    const r = await h.call(
      "update_active_file",
      { vault: "test", content: "# clobber\n" },
      { elicitToken: token },
    );
    expect(errOf(r).code).toBe("replay_drift");
    expect(h.read("Notes/a.md")).toContain("edited elsewhere");
  });
});

describe("ACL: the central stage sees the RESOLVED path", () => {
  it("denies an active note outside the write allowlist without naming its path", async () => {
    const h = harness({
      files: { "Notes/a.md": NOTE_A, "Private/secret.md": "s" },
      acl: { writePaths: ["Notes/**"], deletePaths: ["Notes/**"] },
    });
    h.focus("Private/secret.md");
    for (const [name, input] of [
      ["update_active_file", { vault: "test", content: "x" }],
      ["append_active_file", { vault: "test", content: "x" }],
      ["delete_active_file", { vault: "test" }],
    ] as const) {
      const r = await h.call(name, input);
      const e = errOf(r);
      expect(e.code, name).toBe("acl_denied");
      expect(JSON.stringify(e), name).not.toContain("Private");
      expect(JSON.stringify(e), name).not.toContain("secret");
    }
    expect(h.read("Private/secret.md")).toBe("s");
  });

  it("denies reading an active note outside the read allowlist", async () => {
    const h = harness({
      files: { "Private/secret.md": "s" },
      acl: { readPaths: ["Notes/**"] },
    });
    h.focus("Private/secret.md");
    const e = errOf(await h.call("get_active_file", { vault: "test" }));
    expect(e.code).toBe("acl_denied");
    expect(JSON.stringify(e)).not.toContain("Private");
  });

  it("a default-denied path (.obsidian) is refused for every op", async () => {
    const h = harness({ files: { ".obsidian/app.md": "s" } });
    h.focus(".obsidian/app.md");
    expect(errOf(await h.call("get_active_file", { vault: "test" })).code).toBe("acl_denied");
    expect(errOf(await h.call("update_active_file", { vault: "test", content: "x" })).code).toBe(
      "acl_denied",
    );
  });

  it("per-vault override: the same relative path is allowed in one vault and denied in another", async () => {
    const h = harness({
      files: { "Notes/a.md": NOTE_A },
      otherFiles: { "Notes/a.md": NOTE_A },
      otherAcl: { writePaths: ["Archive/**"] },
    });
    h.focus("Notes/a.md");
    okData(await h.call("append_active_file", { vault: "test", content: "- ok" }));
    const denied = errOf(await h.call("append_active_file", { vault: "other", content: "- no" }));
    expect(denied.code).toBe("acl_denied");
    expect(h.read("Notes/a.md")).toContain("- ok");
    expect(h.read("Notes/a.md", "other")).toBe(NOTE_A);
  });

  it("a caller without the scope never reaches the live session", async () => {
    const h = harness({ files: { "Notes/a.md": NOTE_A } });
    h.focus("Notes/a.md");
    const r = await h.call(
      "update_active_file",
      { vault: "test", content: "x" },
      { grantedScopes: new Set(["read:notes"]) },
    );
    expect(errOf(r).code).toBe("forbidden");
    expect(h.requests).toHaveLength(0);
  });

  it("a read-only vault never reaches the live session for a mutating tool", async () => {
    const h = harness({ files: { "Notes/a.md": NOTE_A }, acl: { readOnly: true } });
    h.focus("Notes/a.md");
    const r = await h.call("append_active_file", { vault: "test", content: "x" });
    expect(r.ok).toBe(false);
    expect(h.requests).toHaveLength(0);
  });
});

describe("non-markdown active file", () => {
  it("is refused for update/append/patch/delete, before any confirmation, and left untouched", async () => {
    const h = harness({ files: { "Boards/plan.canvas": "{}", "Docs/paper.pdf": "%PDF" } });
    for (const active of ["Boards/plan.canvas", "Docs/paper.pdf"]) {
      h.focus(active);
      const inputs: Array<[string, Record<string, unknown>]> = [
        ["update_active_file", { vault: "test", content: "x" }],
        ["append_active_file", { vault: "test", content: "x" }],
        [
          "patch_active_file",
          { vault: "test", operation: "append", anchor: { type: "frontmatter" }, content: "x" },
        ],
        ["delete_active_file", { vault: "test" }],
      ];
      for (const [name, input] of inputs) {
        const e = errOf(await h.call(name, input));
        expect(e.code, `${name} ${active}`).toBe("invalid_input");
        expect(e.details, name).toMatchObject({ reason: "not_markdown" });
        expect(JSON.stringify(e), name).not.toContain(active);
      }
    }
    expect(h.read("Boards/plan.canvas")).toBe("{}");
    expect(h.has("Docs/paper.pdf")).toBe(true);
  });
});

describe("registration", () => {
  it("declares scopes, the workspace domain, a resolver and a path ACL for every tool", () => {
    const h = harness();
    const defs = h.registry.list().filter((t) => t.name.endsWith("_active_file"));
    expect(defs.map((d) => d.name).sort()).toEqual([
      "append_active_file",
      "delete_active_file",
      "get_active_file",
      "patch_active_file",
      "update_active_file",
    ]);
    const scopes: Record<string, string[]> = {
      get_active_file: ["read:notes"],
      update_active_file: ["write:notes"],
      append_active_file: ["write:notes"],
      patch_active_file: ["write:notes"],
      delete_active_file: ["delete:notes"],
    };
    for (const d of defs) {
      expect(d.domain).toBe("workspace");
      expect(d.vaultArg).toBe("vault");
      expect(d.requiredScopes).toEqual(scopes[d.name]);
      expect(d.resolveTarget).toBeTypeOf("function");
      expect(d.pathAcl?.({ vault: "test", path: "x.md" } as never)).toHaveLength(1);
    }
    expect(defs.find((d) => d.name === "delete_active_file")?.destructive).toBe(true);
  });
});
