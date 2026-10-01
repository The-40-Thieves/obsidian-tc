// Optional provenance stamping, end to end through dispatch with a real recorder and chain:
// write_note / commit_capture / execute_template stamp only notes they CREATE, the commit tool adds
// trailers for recorded writes that are staged, everything is byte-identical when off, and the
// chain still verifies with the stamp inside the recorded `after` digest.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import {
  CapabilityCache,
  createBridgeClient,
  type FakeRequestInfo,
  type FakeRoute,
  fakeBridgeTransport,
} from "../src/bridge";
import { elicitVerifier, issueElicitToken } from "../src/elicit";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { ProvenanceStamper, type StampConfig } from "../src/provenance/stamp";
import { verifyProvenance } from "../src/provenance/verify";
import { registerM1Tools } from "../src/tools/m1";
import { registerM4Tools } from "../src/tools/m4";
import { registerM5Tools } from "../src/tools/m5";
import { parseNote } from "../src/vault/frontmatter";
import { VaultRegistry } from "../src/vault/registry";
import { provenanceFixture, rowsFor } from "./provenance-helpers";
import { rmTemp } from "./tmp";

const VAULT = "test";
const KEY = "obsidian_tc_provenance";
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const OFF: StampConfig = { gitTrailers: false, frontmatter: false, frontmatterKey: KEY };
const ALICE: Partial<CallerContext> = {
  caller: "alice",
  authVerified: true,
  sessionId: "sess-A",
  claimedProvenance: { model: "model-a" },
};
const BOB: Partial<CallerContext> = {
  caller: "bob",
  sessionId: "sess-B",
  claimedProvenance: { model: "model-b" },
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

interface BootOpts {
  /** undefined = no stamper wired at all (the default deployment). */
  stamp?: Partial<StampConfig>;
  routes?: Record<string, FakeRoute>;
  /** Runs inside the fake bridge when a request lands (stands in for the plugin's own writes). */
  onBridge?: (info: FakeRequestInfo, root: string) => void;
}

async function boot(opts: BootOpts = {}) {
  const fx = await provenanceFixture();
  const root = mkdtempSync(join(tmpdir(), "obtc-stamp-vault-"));
  const cacheDir = mkdtempSync(join(tmpdir(), "obtc-stamp-cache-"));
  cleanups.push(() => {
    rmTemp(root);
    rmTemp(cacheDir);
    rmTemp(fx.dir);
  });
  const stamper = opts.stamp
    ? new ProvenanceStamper({
        db: fx.db,
        config: { ...OFF, ...opts.stamp },
        onError: (what, e) => {
          throw new Error(`stamp fault (${what}): ${String(e)}`);
        },
      })
    : undefined;
  const vaultRegistry = new VaultRegistry([{ id: VAULT, name: VAULT, path: root }]);
  const requests: FakeRequestInfo[] = [];
  const capabilities = new CapabilityCache();
  capabilities.set(VAULT, {
    companion: "reachable",
    plugins: { git: { installed: true }, templater: { installed: true } },
  });
  const client = createBridgeClient({
    baseUrl: "http://127.0.0.1:27124",
    apiKey: "k",
    fetchFn: fakeBridgeTransport({
      routes: opts.routes ?? {},
      onRequest: (i) => {
        requests.push(i);
        opts.onBridge?.(i, root);
      },
    }),
  });
  const registry = new ToolRegistry({
    verifyElicit: elicitVerifier,
    provenance: fx.recorder,
    rootResolver: () => root,
  });
  const stampDep = stamper ? { provenanceStamp: stamper } : {};
  registerM1Tools(registry, {
    vaultRegistry,
    version: "test",
    startedAt: 0,
    embeddings: { provider: "ollama", model: "nomic-embed-text" },
    ...stampDep,
  });
  registerM4Tools(registry, { vaultRegistry, capabilities, bridgeFor: () => client, ...stampDep });
  registerM5Tools(registry, { vaultRegistry, cacheDir, ...stampDep });
  const acl = new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] });
  const ctx = (over: Partial<CallerContext> = {}): CallerContext => ({
    caller: "test",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: VAULT,
    db: fx.db,
    acl,
    ...over,
  });
  const call = (name: string, input: Record<string, unknown>, over?: Partial<CallerContext>) =>
    registry.dispatch(name, input, ctx(over));
  /** Raise the HITL request, mint a token for it, and dispatch with the token. */
  const confirmed = async (
    name: string,
    input: Record<string, unknown>,
    over?: Partial<CallerContext>,
  ) => {
    const first = await call(name, input, over);
    if (first.ok) return first;
    const hash = (first.error.details as { args_hash: string }).args_hash;
    const token = issueElicitToken(fx.db, {
      vaultId: VAULT,
      toolName: name,
      argsHash: hash,
      caller: over?.caller ?? "test",
    });
    return call(name, input, { ...over, elicitToken: token });
  };
  const put = (rel: string, content: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  };
  const read = (rel: string) => readFileSync(join(root, rel), "utf8");
  const verify = () => verifyProvenance(fx.db, { resolveKey: fx.resolveKey() });
  return { fx, root, call, confirmed, put, read, requests, verify };
}

const stampOf = (raw: string) => parseNote(raw).frontmatter?.[KEY] as Record<string, unknown>;

describe("stamping is off by default", () => {
  it("off by default: nothing is stamped or trailed with no stamper, and the bytes are the caller's", async () => {
    const b = await boot({
      routes: {
        "POST /obsidian-tc/v1/git/commit": { body: { ok: true, result: { committed: 1 } } },
      },
    });
    expect(
      (await b.call("write_note", { vault: VAULT, path: "a.md", content: "plain" }, ALICE)).ok,
    ).toBe(true);
    expect(b.read("a.md")).toBe("plain");
    const cap = await b.call("enqueue_capture", { vault: VAULT, content: "thought", title: "T" });
    expect(cap.ok).toBe(true);
    const id = (cap as { data: { capture_id: string } }).data.capture_id;
    expect(
      (await b.call("commit_capture", { vault: VAULT, capture_id: id, target_path: "c.md" }, ALICE))
        .ok,
    ).toBe(true);
    expect(b.read("c.md")).not.toContain(KEY);
    const r = await b.confirmed("git_commit", { vault: VAULT, message: "snapshot" }, ALICE);
    expect(r.ok).toBe(true);
    // No status round trip and no trailers: the bridge saw the caller's message verbatim.
    expect(b.requests.map((q) => q.url.split("/v1")[1])).toEqual(["/git/commit"]);
    expect(JSON.parse(b.requests[0]?.body ?? "{}")).toEqual({ message: "snapshot" });
    if (r.ok) expect(r.data).not.toHaveProperty("stamped_trailers");
    expect(b.verify().every((v) => v.ok)).toBe(true);
  });

  it("off by default: a stamper with both flags false changes nothing either", async () => {
    const b = await boot({ stamp: {} });
    await b.call("write_note", { vault: VAULT, path: "a.md", content: "# x\n" }, ALICE);
    expect(b.read("a.md")).toBe("# x\n");
  });
});

describe("frontmatter stamp", () => {
  it("stamps a note write_note creates: session, verified principal, self-reported model, seq", async () => {
    const b = await boot({ stamp: { frontmatter: true } });
    const r = await b.call(
      "write_note",
      { vault: VAULT, path: "n.md", content: "---\ntitle: Mine\n---\nbody\n" },
      ALICE,
    );
    expect(r.ok).toBe(true);
    const raw = b.read("n.md");
    expect(parseNote(raw).frontmatter).toMatchObject({ title: "Mine" });
    expect(stampOf(raw)).toEqual({
      session: "sess-A",
      principal: "alice",
      model_self_reported: "model-a",
      seq: 1,
    });
    expect(raw.startsWith("---\ntitle: Mine\n")).toBe(true);
    expect(raw.endsWith("---\nbody\n")).toBe(true);
  });

  it("never claims what it does not know: unverified principal, no model, no session", async () => {
    const b = await boot({ stamp: { frontmatter: true } });
    await b.call("write_note", { vault: VAULT, path: "n.md", content: "x" }, { caller: "mallory" });
    expect(stampOf(b.read("n.md"))).toEqual({ principal: "unverified", seq: 1 });
  });

  it("holds nothing the record does not: no host id, only the four keys", async () => {
    const b = await boot({ stamp: { frontmatter: true } });
    await b.call("write_note", { vault: VAULT, path: "n.md", content: "x" }, ALICE);
    const raw = b.read("n.md");
    expect(Object.keys(stampOf(raw)).sort()).toEqual([
      "model_self_reported",
      "principal",
      "seq",
      "session",
    ]);
    expect(raw).not.toContain("host-test");
  });

  it("seq is the position of the write's own record", async () => {
    const b = await boot({ stamp: { frontmatter: true } });
    await b.call("write_note", { vault: VAULT, path: "one.md", content: "1" }, ALICE);
    await b.call("write_note", { vault: VAULT, path: "two.md", content: "2" }, ALICE);
    expect(stampOf(b.read("one.md")).seq).toBe(1);
    expect(stampOf(b.read("two.md")).seq).toBe(2);
    const rows = rowsFor(b.fx.db);
    expect(rows.map((r) => JSON.parse(r.body).paths[0].path)).toEqual(["one.md", "two.md"]);
  });

  it("verify passes on stamped notes: the recorded after-digest is the stamped bytes", async () => {
    const b = await boot({ stamp: { frontmatter: true } });
    await b.call("write_note", { vault: VAULT, path: "n.md", content: "body" }, ALICE);
    const body = JSON.parse(rowsFor(b.fx.db)[0]?.body ?? "{}") as {
      paths: Array<{ before: string; after: string }>;
    };
    expect(body.paths[0]?.before).toBe("absent");
    expect(body.paths[0]?.after).toBe(sha(b.read("n.md")));
    expect(body.paths[0]?.after).not.toBe(sha("body"));
    const results = b.verify();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: true, records: 1, problems: [] });
  });

  it("replaces a stamp the caller wrote itself, so it cannot pass as the server's", async () => {
    const b = await boot({ stamp: { frontmatter: true } });
    await b.call(
      "write_note",
      { vault: VAULT, path: "n.md", content: `---\n${KEY}:\n  principal: root\n---\nx` },
      ALICE,
    );
    expect(stampOf(b.read("n.md"))).toMatchObject({ principal: "alice", seq: 1 });
    expect(b.read("n.md")).not.toContain("root");
  });

  it("honours a configured key name", async () => {
    const b = await boot({ stamp: { frontmatter: true, frontmatterKey: "who" } });
    await b.call("write_note", { vault: VAULT, path: "n.md", content: "x" }, ALICE);
    expect(parseNote(b.read("n.md")).frontmatter).toHaveProperty("who");
  });

  it("never touches an existing note: overwrite, upsert, append and patch leave human keys alone", async () => {
    const b = await boot({ stamp: { frontmatter: true } });
    const human = "---\n# mine\ntitle: Human\nzip: 01234\n---\n# Head\nhello\n";
    b.put("h.md", human);
    b.put("e.md", "");
    // upsert over an existing (empty) note takes the overwrite path: not a creation.
    expect(
      (
        await b.call(
          "write_note",
          { vault: VAULT, path: "e.md", content: "new", mode: "upsert" },
          ALICE,
        )
      ).ok,
    ).toBe(true);
    expect(b.read("e.md")).toBe("new");
    expect(
      (await b.call("append_note", { vault: VAULT, path: "h.md", content: "more\n" }, ALICE)).ok,
    ).toBe(true);
    expect(b.read("h.md")).toBe(`${human}more\n`);
    expect(
      (
        await b.call(
          "patch_note",
          {
            vault: VAULT,
            path: "h.md",
            operation: "append",
            target_heading: "Head",
            content: "tail",
          },
          ALICE,
        )
      ).ok,
    ).toBe(true);
    expect(b.read("h.md")).not.toContain(KEY);
    expect(
      b.read("h.md").startsWith("---\n# mine\ntitle: Human\nzip: 01234\n---\n# Head\nhello\n"),
    ).toBe(true);
  });

  it("append_note creating a missing note is not stamped (only the creation tools named in the docs are)", async () => {
    const b = await boot({ stamp: { frontmatter: true } });
    await b.call(
      "append_note",
      { vault: VAULT, path: "new.md", content: "x", create_if_missing: true },
      ALICE,
    );
    expect(b.read("new.md")).toBe("x");
  });

  it("stamps a committed capture, keeping its frontmatter overrides", async () => {
    const b = await boot({ stamp: { frontmatter: true } });
    const cap = await b.call("enqueue_capture", { vault: VAULT, content: "thought", title: "T" });
    const id = (cap as { data: { capture_id: string } }).data.capture_id;
    const r = await b.call(
      "commit_capture",
      {
        vault: VAULT,
        capture_id: id,
        target_path: "inbox/c.md",
        frontmatter_overrides: { status: "new" },
      },
      ALICE,
    );
    expect(r.ok).toBe(true);
    const raw = b.read("inbox/c.md");
    expect(parseNote(raw).frontmatter).toMatchObject({ status: "new", title: "T" });
    expect(stampOf(raw)).toMatchObject({ principal: "alice", session: "sess-A" });
    if (r.ok) expect((r.data as { content_hash: string }).content_hash).toBe(sha(raw));
    expect(b.verify().every((v) => v.ok)).toBe(true);
  });

  const templaterRoutes = {
    "POST /obsidian-tc/v1/templater/execute": { body: { ok: true, result: { created_at: "t" } } },
  };
  const plugin = (info: FakeRequestInfo, root: string) => {
    if (!info.url.endsWith("/templater/execute")) return;
    const { target } = JSON.parse(info.body ?? "{}") as { target: string };
    const abs = join(root, target.endsWith(".md") ? target : `${target}.md`);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, "---\ntitle: From template\n---\nexpanded\n");
  };

  it("stamps a note Templater created, but not one it overwrote", async () => {
    const b = await boot({
      stamp: { frontmatter: true },
      routes: templaterRoutes,
      onBridge: plugin,
    });
    b.put("tpl.md", "template");
    const created = await b.confirmed(
      "execute_template",
      { vault: VAULT, template: "tpl.md", target: "out/new.md" },
      ALICE,
    );
    expect(created.ok).toBe(true);
    const raw = b.read("out/new.md");
    expect(parseNote(raw).frontmatter).toMatchObject({ title: "From template" });
    expect(stampOf(raw)).toMatchObject({ principal: "alice", session: "sess-A" });
    expect(raw.endsWith("---\nexpanded\n")).toBe(true);

    const replaced = await b.confirmed(
      "execute_template",
      { vault: VAULT, template: "tpl.md", target: "out/new.md", overwrite: true },
      ALICE,
    );
    expect(replaced.ok).toBe(true);
    expect(b.read("out/new.md")).toBe("---\ntitle: From template\n---\nexpanded\n");
  });
});

describe("commit trailers", () => {
  const status = (staged: string[]) => ({
    "POST /obsidian-tc/v1/git/status": {
      body: { ok: true, result: { staged: staged.map((path) => ({ path, index: "A" })) } },
    },
    "POST /obsidian-tc/v1/git/commit": { body: { ok: true, result: { committed: 1 } } },
  });
  const commitMessage = (b: Awaited<ReturnType<typeof boot>>): string =>
    JSON.parse(b.requests.find((q) => q.url.endsWith("/git/commit"))?.body ?? "{}").message;

  it("trails the recorded writes in the commit, tagging what is self-reported", async () => {
    const b = await boot({
      stamp: { gitTrailers: true },
      routes: status(["a.md", "b.md", "human.md"]),
    });
    await b.call("write_note", { vault: VAULT, path: "a.md", content: "A" }, ALICE);
    await b.call("write_note", { vault: VAULT, path: "unstaged.md", content: "U" }, ALICE);
    await b.call("write_note", { vault: VAULT, path: "b.md", content: "B" }, BOB);
    b.put("human.md", "written by a human, never recorded");
    const r = await b.confirmed("git_commit", { vault: VAULT, message: "snapshot" }, ALICE);
    expect(r.ok).toBe(true);
    expect(commitMessage(b)).toBe(
      [
        "snapshot",
        "",
        "Obsidian-TC-Session: sess-A",
        "Obsidian-TC-Session: sess-B",
        "Obsidian-TC-Principal: alice",
        "Obsidian-TC-Principal: unverified",
        "Obsidian-TC-Model: model-a (self-reported)",
        "Obsidian-TC-Model: model-b (self-reported)",
        // a.md is seq 1 and b.md seq 3; unstaged.md (seq 2) is inside the range but not in the commit.
        "Obsidian-TC-Provenance-Seq: test:1-3",
      ].join("\n"),
    );
    if (r.ok) {
      expect((r.data as { stamped_trailers: string[] }).stamped_trailers).toHaveLength(7);
    }
  });

  it("a commit with no provenance-recorded writes gets no trailers and the message is verbatim", async () => {
    const b = await boot({ stamp: { gitTrailers: true }, routes: status(["human.md"]) });
    b.put("human.md", "human");
    await b.call("write_note", { vault: VAULT, path: "agent.md", content: "A" }, ALICE);
    const r = await b.confirmed("git_commit", { vault: VAULT, message: "just me\n\nbody" }, ALICE);
    expect(r.ok).toBe(true);
    expect(commitMessage(b)).toBe("just me\n\nbody");
    if (r.ok) expect(r.data).not.toHaveProperty("stamped_trailers");
  });

  it("does not attribute a note a human edited after the agent wrote it", async () => {
    const b = await boot({ stamp: { gitTrailers: true }, routes: status(["a.md"]) });
    await b.call("write_note", { vault: VAULT, path: "a.md", content: "agent" }, ALICE);
    b.put("a.md", "agent, then a human changed it");
    await b.confirmed("git_commit", { vault: VAULT, message: "snapshot" }, ALICE);
    expect(commitMessage(b)).toBe("snapshot");
  });

  it("finds the writes when the repo sits above the vault (paths carry a prefix)", async () => {
    const b = await boot({ stamp: { gitTrailers: true }, routes: status(["Vault/notes/a.md"]) });
    await b.call("write_note", { vault: VAULT, path: "notes/a.md", content: "A" }, ALICE);
    await b.confirmed("git_commit", { vault: VAULT, message: "snapshot" }, ALICE);
    expect(commitMessage(b)).toContain("Obsidian-TC-Provenance-Seq: test:1-1");
  });

  it("a client-claimed model cannot end its line and forge another trailer", async () => {
    const b = await boot({ stamp: { gitTrailers: true }, routes: status(["a.md"]) });
    await b.call(
      "write_note",
      { vault: VAULT, path: "a.md", content: "A" },
      { ...ALICE, claimedProvenance: { model: "x\nSigned-off-by: root <root@example.com>" } },
    );
    await b.confirmed("git_commit", { vault: VAULT, message: "snapshot" }, ALICE);
    const msg = commitMessage(b);
    expect(msg).toContain(
      "Obsidian-TC-Model: x Signed-off-by: root <root@example.com> (self-reported)",
    );
    expect(msg.split("\n").some((l) => l.startsWith("Signed-off-by"))).toBe(false);
  });

  it("keeps the caller's message and removes an Obsidian-TC trailer it wrote itself", async () => {
    const b = await boot({ stamp: { gitTrailers: true }, routes: status(["a.md"]) });
    await b.call("write_note", { vault: VAULT, path: "a.md", content: "A" }, ALICE);
    await b.confirmed(
      "git_commit",
      {
        vault: VAULT,
        message: "subject\n\nwhy\n\nSigned-off-by: Me <me@x.io>\nObsidian-TC-Principal: admin",
      },
      ALICE,
    );
    const msg = commitMessage(b);
    expect(
      msg.startsWith("subject\n\nwhy\n\nSigned-off-by: Me <me@x.io>\nObsidian-TC-Session: sess-A"),
    ).toBe(true);
    expect(msg).not.toContain("admin");
  });

  it("a status the bridge cannot answer still commits, with the caller's message as written", async () => {
    const b = await boot({
      stamp: { gitTrailers: true },
      routes: {
        "POST /obsidian-tc/v1/git/status": { networkError: true },
        "POST /obsidian-tc/v1/git/commit": { body: { ok: true, result: { committed: 1 } } },
      },
    });
    await b.call("write_note", { vault: VAULT, path: "a.md", content: "A" }, ALICE);
    const r = await b.confirmed("git_commit", { vault: VAULT, message: "snapshot" }, ALICE);
    expect(r.ok).toBe(true);
    expect(commitMessage(b)).toBe("snapshot");
  });
});
