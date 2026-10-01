// search_and_read: search, then return the top-k FULL notes (or the matched sections) in one call.
// It reuses vault_graph_search's ranking/filters and read_notes' read path + byte-page.ts's paginator,
// so each case below pins one property of that composition: search order, the k cap, a hidden note
// never surfacing (not even as a denied item), the vault's OWN ACL (parity with read_notes), the
// per-item denial audit, budget pagination, section mode, the truncation marker, cursor binding.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { createPagingDeps } from "../src/mcp/byte-page";
import { MetricsRecorder } from "../src/metrics/registry";
import { indexVault } from "../src/search/indexer";
import { buildRepresentationManifest } from "../src/search/representation";
import { registerM7Tools } from "../src/tools/m7";
import { candidatePoolSize } from "../src/tools/m7/knowledge/search-and-read";
import { makeTestVault, type TestVault, type TestVaultOptions } from "./m1-helpers";

interface Entry {
  path: string;
  rank: number;
  score: number;
  chunk_id?: string;
  heading?: string | null;
  section_resolved?: boolean;
  frontmatter?: Record<string, unknown> | null;
  body: string;
  content_hash: string;
  size_bytes: number;
  truncated: boolean;
}
interface Page {
  vault: string;
  mode: "note" | "section";
  notes: Entry[];
  errors: Array<{
    rank: number;
    path?: string;
    code: string;
    message: string;
    size?: number;
    budget?: number;
  }>;
  next_cursor: string | null;
}

const vaults: TestVault[] = [];
afterEach(() => {
  for (const v of vaults.splice(0)) v.cleanup();
});

const DIMS = 32;
const doc = (title: string, extra = "") =>
  `---\ntitle: ${title}\n---\n# ${title}\n\nzeta quokka ${title.toLowerCase()} ${extra}\n`;

async function setup(
  files: Record<string, string>,
  over: Partial<TestVaultOptions> = {},
): Promise<{ v: TestVault; metrics: MetricsRecorder; emitted: string[] }> {
  const metrics = new MetricsRecorder();
  const emitted: string[] = [];
  const v = makeTestVault({
    files,
    centralAcl: true,
    metrics,
    ...over,
    registryOpts: { metrics, emit: (_vid, type) => emitted.push(type), ...over.registryOpts },
  });
  vaults.push(v);
  const provider = fakeEmbeddingProvider({ dimensions: DIMS, model: "A" });
  await indexVault({
    db: v.db,
    provider,
    representation: buildRepresentationManifest(provider, {}),
    vaultId: v.id,
    root: v.root,
    // Index EVERYTHING: hiding a note is the search-time ACL's job, not the indexer's.
    isReadable: () => true,
  });
  registerM7Tools(v.registry, {
    vaultRegistry: v.vaultRegistry,
    embeddingProvider: provider,
    reranker: null,
    roles: null,
    acl: v.acl,
    paging: createPagingDeps({
      secret: "test-secret",
      budgetBytes: () => v.registry.maxResponseBytes,
    }),
  });
  return { v, metrics, emitted };
}

const sar = async (
  v: TestVault,
  input: Record<string, unknown>,
  over?: Parameters<TestVault["call"]>[2],
) => v.call("search_and_read", { vault: "test", query: "zeta quokka", ...input }, over);

async function ok(
  v: TestVault,
  input: Record<string, unknown>,
  over?: Parameters<TestVault["call"]>[2],
) {
  const r = await sar(v, input, over);
  if (!r.ok) throw new Error(`search_and_read failed: ${JSON.stringify(r.error)}`);
  return r.data as Page;
}

const FIVE = Object.fromEntries(
  ["a", "b", "c", "d", "e"].map((n) => [`notes/${n}.md`, doc(n.toUpperCase(), `${n} `.repeat(8))]),
);

describe("search_and_read: ranking and k", () => {
  it("returns the top-k notes in exactly vault_graph_search's order, one entry per note", async () => {
    const { v } = await setup(FIVE);
    const k = 3;
    const search = await v.call("vault_graph_search", {
      vault: "test",
      query: "zeta quokka",
      final_top_k: candidatePoolSize(k),
    });
    if (!search.ok) throw new Error("search failed");
    const expected = [
      ...new Set((search.data as { results: Array<{ path: string }> }).results.map((r) => r.path)),
    ].slice(0, k);
    expect(expected).toHaveLength(k);

    const d = await ok(v, { k });
    expect(d.notes.map((n) => n.path)).toEqual(expected);
    expect(d.notes.map((n) => n.rank)).toEqual([1, 2, 3]);
    expect(d.errors).toEqual([]);
    expect(d.next_cursor).toBeNull();
    expect(d.mode).toBe("note");
  });

  it("each entry is the note read_notes returns: same body, frontmatter and content hash", async () => {
    const { v } = await setup(FIVE);
    const d = await ok(v, { k: 5 });
    const rn = await v.call("read_notes", { vault: "test", paths: d.notes.map((n) => n.path) });
    if (!rn.ok) throw new Error("read_notes failed");
    const byPath = new Map(
      (
        rn.data as {
          notes: Array<{
            path: string;
            body: string;
            frontmatter: unknown;
            content_hash: string;
          }>;
        }
      ).notes.map((n) => [n.path, n]),
    );
    expect(d.notes).toHaveLength(5);
    for (const n of d.notes) {
      const ref = byPath.get(n.path);
      expect(ref).toBeDefined();
      expect(n.body).toBe(ref?.body);
      expect(n.frontmatter).toEqual(ref?.frontmatter);
      expect(n.content_hash).toBe(ref?.content_hash);
      expect(n.truncated).toBe(false);
    }
  });

  it("caps k: 20 is accepted, 21 and 0 are refused", async () => {
    const { v } = await setup(FIVE);
    expect((await sar(v, { k: 20 })).ok).toBe(true);
    for (const k of [21, 0, -1, 1.5]) {
      const r = await sar(v, { k });
      expect(r.ok, `k=${k}`).toBe(false);
    }
  });

  it("returns at most k notes when more match", async () => {
    const { v } = await setup(FIVE);
    expect((await ok(v, { k: 2 })).notes).toHaveLength(2);
  });
});

describe("search_and_read: ACL", () => {
  const FILES = {
    "pub/a.md": doc("PubA"),
    "pub/b.md": doc("PubB"),
    "secret/hidden.md": doc("Hidden", "the-classified-token"),
  };

  it("a note the caller cannot read never appears, not even as a denied item, and costs no audit row", async () => {
    const { v, emitted } = await setup(FILES, { acl: { readPaths: ["pub/**"] } });
    const d = await ok(v, { k: 20 });
    expect(d.notes.map((n) => n.path).sort()).toEqual(["pub/a.md", "pub/b.md"]);
    expect(d.errors).toEqual([]);
    expect(JSON.stringify(d)).not.toMatch(/secret|hidden|classified/i);
    expect(v.events().filter((e) => e.status === "error")).toEqual([]);
    expect(emitted.filter((t) => t === "tc.acl.denied")).toEqual([]);
  });

  it("uses the vault's OWN ACL: a permissive root with a narrowing per-vault override hides the note, and parity with read_notes holds", async () => {
    const { v } = await setup(FILES, {
      acl: { readPaths: ["**"] },
      aclByVault: { test: { readPaths: ["pub/**"] } },
    });
    const d = await ok(v, { k: 20 });
    expect(d.notes.map((n) => n.path).sort()).toEqual(["pub/a.md", "pub/b.md"]);
    // read_notes is the reference: it succeeds on exactly the paths search_and_read returned...
    const allowed = await v.call("read_notes", {
      vault: "test",
      paths: d.notes.map((n) => n.path),
    });
    expect(allowed.ok).toBe(true);
    // ...and refuses the one it hid.
    const denied = await v.call("read_notes", { vault: "test", paths: ["secret/hidden.md"] });
    expect(denied.ok).toBe(false);
  });

  it("applies the vault's override even when the caller context carries only the root ACL (no dispatch swap)", async () => {
    const { v } = await setup(FILES, {
      acl: { readPaths: ["**"] },
      aclByVault: { test: { readPaths: ["pub/**"] } },
    });
    const def = v.registry.list().find((t) => t.name === "search_and_read");
    if (!def) throw new Error("search_and_read is not registered");
    const out = (await def.handler(
      { vault: "test", query: "zeta quokka", k: 20, mode: "note" },
      v.ctx(), // ctx.acl is the ROOT acl; dispatch's per-vault swap is bypassed here
    )) as Page;
    expect(out.notes.map((n) => n.path).sort()).toEqual(["pub/a.md", "pub/b.md"]);
  });

  it("a rule-scoped note the caller lacks the scope for is never a search candidate: no body, no error item, no denial", async () => {
    const { v, emitted } = await setup(
      { "open/a.md": doc("OpenA"), "gated/g.md": doc("Gated", "gated-token") },
      {
        acl: {
          rules: [{ glob: "gated/**", scopes: ["read:secret"] }],
        },
      },
    );
    const d = await ok(v, { k: 20 }, { grantedScopes: new Set(["read:notes"]) });
    expect(d.notes.map((n) => n.path)).toEqual(["open/a.md"]);
    expect(JSON.stringify(d)).not.toMatch(/gated/i);
    // The search itself honours the path's rule-scope, so the note never reaches the read stage.
    expect(d.errors).toEqual([]);
    expect(emitted.filter((t) => t === "tc.acl.denied")).toEqual([]);
    const granted = await ok(
      v,
      { k: 20 },
      { grantedScopes: new Set(["read:notes", "read:secret"]) },
    );
    expect(granted.notes.map((n) => n.path).sort()).toEqual(["gated/g.md", "open/a.md"]);
  });

  // Five ~2 KB notes under a tiny budget span several pages; `revoke` runs between pages.
  const PAGED = { maxResponseBytes: 4000 };
  const PAGED_FILES = Object.fromEntries(
    ["a", "b", "c", "d", "e"].map((n) => [`n/${n}.md`, doc(n.toUpperCase(), "w".repeat(1200))]),
  );
  const PAGE_ARGS = { k: 5, max_bytes_per_item: 1500 };
  async function walkOrder(v: TestVault): Promise<string[]> {
    const order: string[] = [];
    let page = await ok(v, PAGE_ARGS);
    for (;;) {
      order.push(...page.notes.map((n) => n.path));
      if (!page.next_cursor) return order;
      page = await ok(v, { ...PAGE_ARGS, cursor: page.next_cursor });
    }
  }
  const onlyReadable = (paths: string[]) =>
    new FolderAcl({ readOnly: false, defaultScopes: [], rules: [], readPaths: paths });
  /** Page 1 under the caller's ACL, then every later page under `laterAcl`. */
  async function walkThenChange(v: TestVault, laterAcl: FolderAcl): Promise<Page[]> {
    const pages = [await ok(v, PAGE_ARGS)];
    expect(pages[0]?.next_cursor).not.toBeNull();
    let c = pages[0]?.next_cursor ?? null;
    while (c) {
      const p = await ok(v, { ...PAGE_ARGS, cursor: c }, { acl: laterAcl });
      pages.push(p);
      c = p.next_cursor;
    }
    return pages;
  }

  it("a note revoked between pages becomes a denied item: masked as missing, and audited like read_notes'", async () => {
    const { v, emitted, metrics } = await setup(PAGED_FILES, PAGED);
    const order = await walkOrder(v);
    expect(order).toHaveLength(5);
    const target = order[4] as string;
    const pages = await walkThenChange(v, onlyReadable(order.slice(0, 4)));
    const errors = pages.flatMap((p) => p.errors);
    // Indistinguishable from a missing note: same code/message, and it names no path.
    expect(errors).toEqual([{ rank: 5, code: "note_not_found", message: "note not found" }]);
    expect(JSON.stringify(pages)).not.toContain(target);
    const rows = v.events().filter((e) => e.tool_name === "search_and_read");
    expect(rows.filter((e) => e.status === "error").map((e) => e.error_code)).toEqual([
      "acl_denied",
    ]);
    expect(emitted.filter((t) => t === "tc.acl.denied")).toHaveLength(1);
    expect(await metrics.metrics()).toMatch(
      /obsidian_tc_acl_denied_total\{vault="test",scope_class="read",reason="acl_denied"\} 1/,
    );
  });

  it("a denied item and a missing item are byte-identical apart from rank; a missing item is not audited as a denial", async () => {
    const denied = await setup(PAGED_FILES, PAGED);
    const order = await walkOrder(denied.v);
    const target = order[4] as string;
    const deniedErr = (await walkThenChange(denied.v, onlyReadable(order.slice(0, 4)))).flatMap(
      (p) => p.errors,
    );

    const missing = await setup(PAGED_FILES, PAGED);
    const first = await ok(missing.v, PAGE_ARGS);
    rmSync(join(missing.v.root, target)); // the note vanishes after the search
    const missingErr: Page["errors"] = [];
    let c = first.next_cursor;
    while (c) {
      const p = await ok(missing.v, { ...PAGE_ARGS, cursor: c });
      missingErr.push(...p.errors);
      c = p.next_cursor;
    }
    expect(deniedErr).toHaveLength(1);
    expect(missingErr).toEqual(deniedErr);
    expect(missing.v.events().filter((e) => e.status === "error")).toEqual([]);
    expect(missing.emitted.filter((t) => t === "tc.acl.denied")).toEqual([]);
  });
});

describe("search_and_read: byte budget", () => {
  const big = (n: string, bytes: number) => doc(n, "w".repeat(bytes));
  const BIG = Object.fromEntries(["a", "b", "c", "d", "e"].map((n) => [`n/${n}.md`, big(n, 2500)]));

  it("pages over the budget with next_cursor: no duplicate, no gap, every page within budget, order preserved", async () => {
    const budget = 6000;
    const { v } = await setup(BIG, { maxResponseBytes: budget });
    const first = await ok(v, { k: 5, max_bytes_per_item: 3000 });
    expect(first.next_cursor).not.toBeNull();
    const pages = [first];
    let c = first.next_cursor;
    while (c) {
      const p = await ok(v, { k: 5, max_bytes_per_item: 3000, cursor: c });
      expect(p.notes.length + p.errors.length).toBeGreaterThan(0);
      pages.push(p);
      c = p.next_cursor;
    }
    for (const p of pages) expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThanOrEqual(budget);
    const paths = pages.flatMap((p) => p.notes.map((n) => n.path));
    expect(paths).toHaveLength(5);
    expect(new Set(paths).size).toBe(5);
    expect(pages.flatMap((p) => p.notes.map((n) => n.rank))).toEqual([1, 2, 3, 4, 5]);
    expect(pages.length).toBeGreaterThan(1);
  });

  it("by default every selected note gets an equal share of the budget, so the top-k fit ONE page", async () => {
    const { v } = await setup(BIG, { maxResponseBytes: 6000 });
    const d = await ok(v, { k: 5 });
    expect(d.notes).toHaveLength(5);
    expect(d.next_cursor).toBeNull();
    expect(d.notes.every((n) => n.truncated)).toBe(true);
  });

  it("marks a note cut to its share: truncated true and size_bytes is the original body size", async () => {
    const { v } = await setup(
      { "one.md": big("One", 20_000), "two.md": doc("Two") },
      {
        maxResponseBytes: 8000,
      },
    );
    const d = await ok(v, { k: 2 });
    const one = d.notes.find((n) => n.path === "one.md");
    const two = d.notes.find((n) => n.path === "two.md");
    expect(one?.truncated).toBe(true);
    expect(one?.size_bytes).toBeGreaterThan(20_000);
    expect(Buffer.byteLength(one?.body ?? "")).toBeLessThan(one?.size_bytes ?? 0);
    expect(one?.body.startsWith("# One")).toBe(true);
    // The small note is whole and unmarked.
    expect(two?.truncated).toBe(false);
    expect(two?.size_bytes).toBe(Buffer.byteLength(two?.body ?? ""));
    expect(Buffer.byteLength(JSON.stringify(d))).toBeLessThanOrEqual(8000);
  });

  it("truncates on a character boundary (never a split surrogate pair)", async () => {
    const { v } = await setup(
      { "emoji.md": doc("Emoji", "\u{1F600}".repeat(4000)) },
      {
        maxResponseBytes: 5000,
      },
    );
    const d = await ok(v, { k: 1 });
    expect(d.notes[0]?.truncated).toBe(true);
    expect(d.notes[0]?.body).not.toMatch(/[\uD800-\uDBFF]$/u);
    expect(JSON.stringify(d)).not.toMatch(/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i);
  });

  it("a note that cannot fit even with an empty body (huge frontmatter) is a too_large error, and the walk still ends", async () => {
    const fm = `---\nblob: ${"z".repeat(9000)}\n---\n# Huge\n\nzeta quokka\n`;
    const { v } = await setup({ "huge.md": fm, "ok.md": doc("Ok") }, { maxResponseBytes: 5000 });
    const seen: Page[] = [];
    let cursor: string | undefined;
    do {
      const p = await ok(v, { k: 2, ...(cursor ? { cursor } : {}) });
      seen.push(p);
      cursor = p.next_cursor ?? undefined;
    } while (cursor);
    const tooLarge = seen.flatMap((p) => p.errors).filter((e) => e.code === "too_large");
    expect(tooLarge).toHaveLength(1);
    expect(tooLarge[0]?.path).toBe("huge.md");
    expect(tooLarge[0]?.budget).toBe(5000);
    expect(seen.flatMap((p) => p.notes).map((n) => n.path)).toEqual(["ok.md"]);
  });
});

describe("search_and_read: section mode", () => {
  const SECTIONED = [
    "---",
    "title: Guide",
    "---",
    "Preamble line about zeta quokka.",
    "",
    "## Setup",
    "",
    "setup details for the zeta quokka install",
    "",
    "### Setup sub",
    "",
    "nested zeta quokka detail",
    "",
    "## Other",
    "",
    "other unrelated stuff",
    "",
  ].join("\n");

  it("returns the matched heading section, not the whole note", async () => {
    const { v } = await setup({ "guide.md": SECTIONED });
    const d = await ok(v, { k: 20, mode: "section" });
    expect(d.mode).toBe("section");
    const setupSec = d.notes.find((n) => n.heading === "Setup");
    expect(setupSec).toBeDefined();
    expect(setupSec?.body.startsWith("## Setup")).toBe(true);
    expect(setupSec?.body).toContain("setup details");
    expect(setupSec?.body).toContain("Setup sub"); // a section spans its sub-headings
    expect(setupSec?.body).not.toContain("other unrelated stuff");
    expect(setupSec?.section_resolved).toBe(true);
    expect(setupSec?.chunk_id).toBeTruthy();
    // frontmatter is a note-level field, not repeated per section
    expect(setupSec?.frontmatter).toBeUndefined();
    // whole-note hash still round-trips into patch_note's prev_hash
    const rn = await v.call("read_notes", { vault: "test", paths: ["guide.md"] });
    if (!rn.ok) throw new Error("read_notes failed");
    expect(setupSec?.content_hash).toBe(
      (rn.data as { notes: Array<{ content_hash: string }> }).notes[0]?.content_hash,
    );
  });

  it("a hit before the first heading resolves to the preamble", async () => {
    const { v } = await setup({ "guide.md": SECTIONED });
    const d = await ok(v, { k: 20, mode: "section" });
    const pre = d.notes.find((n) => n.heading === null);
    expect(pre?.body).toContain("Preamble line");
    expect(pre?.body).not.toContain("## Setup");
  });

  it("one entry per distinct (note, section), ranks 1..n in search order", async () => {
    const { v } = await setup({ "guide.md": SECTIONED });
    const d = await ok(v, { k: 20, mode: "section" });
    const keys = d.notes.map((n) => `${n.path}#${n.heading}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(d.notes.map((n) => n.rank)).toEqual(d.notes.map((_, i) => i + 1));
  });
});

describe("search_and_read: cursor binding", () => {
  const files = Object.fromEntries(
    ["a", "b", "c", "d"].map((n) => [`n/${n}.md`, doc(n.toUpperCase(), "w".repeat(2500))]),
  );
  const args = { k: 4, max_bytes_per_item: 3000 };

  it("resumes only for the same principal, tool and arguments", async () => {
    const { v } = await setup(files, { maxResponseBytes: 5000 });
    const first = await ok(v, args);
    const cursor = first.next_cursor as string;
    expect(cursor).toBeTruthy();

    const other = await sar(v, { ...args, cursor }, { caller: "someone-else" });
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.error.details).toMatchObject({ reason: "foreign" });

    const diffArgs = await sar(v, { ...args, k: 3, cursor });
    expect(diffArgs.ok).toBe(false);
    if (!diffArgs.ok) expect(diffArgs.error.details).toMatchObject({ reason: "request_mismatch" });

    const diffQuery = await sar(v, { ...args, query: "different words", cursor });
    expect(diffQuery.ok).toBe(false);
    if (!diffQuery.ok)
      expect(diffQuery.error.details).toMatchObject({ reason: "request_mismatch" });

    const garbage = await sar(v, { ...args, cursor: "not-a-cursor" });
    expect(garbage.ok).toBe(false);
    if (!garbage.ok) expect(garbage.error.details).toMatchObject({ reason: "invalid" });

    const good = await sar(v, { ...args, cursor });
    expect(good.ok).toBe(true);
  });
});

describe("search_and_read: response_format=concise (GH #1027)", () => {
  it("a note cut to its share keeps truncated and size_bytes; a whole note drops both", async () => {
    const { v } = await setup(
      { "one.md": doc("One", "w".repeat(20_000)), "two.md": doc("Two") },
      { maxResponseBytes: 8000 },
    );
    const full = await ok(v, { k: 2 });
    const d = await ok(v, { k: 2, response_format: "concise" });
    const one = d.notes.find((n) => n.path === "one.md");
    const two = d.notes.find((n) => n.path === "two.md");
    expect(one?.truncated).toBe(true);
    expect(one?.size_bytes).toBe(full.notes.find((n) => n.path === "one.md")?.size_bytes);
    expect(Object.keys(two ?? {}).sort()).toEqual([
      "body",
      "content_hash",
      "path",
      "rank",
      "score",
    ]);
    expect(Buffer.byteLength(JSON.stringify(d))).toBeLessThanOrEqual(8000);
  });
});
