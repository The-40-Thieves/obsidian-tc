// read_resources: batch resources/read. Each obsidian-tc:// note URI goes through the SAME
// readResource() the MCP resources/read handler calls, then the shared byte-page paginator. Every
// case runs through registry.dispatch, i.e. under the real governor.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FolderAcl } from "../src/acl";
import { buildResourceUri, readResource } from "../src/mcp/resources";
import { makeTestVault, type TestVault } from "./m1-helpers";

type Item =
  | { ok: true; uri: string; mimeType: string; text: string }
  | {
      ok: false;
      uri: string;
      error: { code: string; message: string; size?: number; budget?: number };
    };
interface Page {
  results: Item[];
  next_cursor: string | null;
}

const vaults: TestVault[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const v of vaults.splice(0)) v.cleanup();
});

function vault(
  files: Record<string, string>,
  opts: { maxResponseBytes?: number; acl?: object; centralAcl?: boolean } = {},
): TestVault {
  const v = makeTestVault({
    files,
    centralAcl: opts.centralAcl ?? false,
    ...(opts.maxResponseBytes !== undefined ? { maxResponseBytes: opts.maxResponseBytes } : {}),
    ...(opts.acl ? { acl: opts.acl } : {}),
  });
  vaults.push(v);
  return v;
}

const uri = (rel: string, vaultId = "test") => buildResourceUri(vaultId, rel);

async function readPage(
  v: TestVault,
  uris: string[],
  cursor?: string,
  over?: Parameters<TestVault["call"]>[2],
) {
  return v.call("read_resources", { uris, ...(cursor ? { cursor } : {}) }, over);
}

function pageOf(r: Awaited<ReturnType<typeof readPage>>): Page {
  if (!r.ok) throw new Error(`call failed: ${JSON.stringify(r.error)}`);
  return r.data as Page;
}

async function walk(v: TestVault, uris: string[]): Promise<Page[]> {
  const pages: Page[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 500; guard++) {
    const d = pageOf(await readPage(v, uris, cursor));
    pages.push(d);
    if (d.next_cursor === null) return pages;
    expect(d.results.length).toBeGreaterThan(0); // progress
    cursor = d.next_cursor;
  }
  throw new Error("cursor walk did not terminate");
}

const body = (n: number) => "x".repeat(n);
const codeOf = (i: Item) => (i.ok ? null : i.error.code);

describe("read_resources: per-item results", () => {
  it("returns ok items and per-item errors for a mixed batch, in request order", async () => {
    const v = vault(
      { "a.md": "# A", "pub/b.md": "B body", "secret/c.md": "C" },
      {
        acl: {
          readOnly: false,
          defaultScopes: [],
          rules: [],
          readPaths: ["a.md", "pub/**", "missing.md"],
        },
      },
    );
    const uris = [
      uri("a.md"),
      uri("secret/c.md"), // folder ACL denies
      uri("missing.md"), // not found
      "obsidian-tc://test/50%.md", // malformed percent-encoding
      "https://example.com/x.md", // unknown scheme
      "obsidian-tc://catalog", // not a note URI
      "obsidian-tc://noslash", // malformed shape
      uri("pub/b.md"),
      uri("elsewhere.md", "other"), // another vault
    ];
    const d = pageOf(await readPage(v, uris));
    expect(d.next_cursor).toBeNull();
    expect(d.results.map((r) => r.uri)).toEqual(uris);
    expect(d.results.map((r) => (r.ok ? "ok" : r.error.code))).toEqual([
      "ok",
      "acl_denied",
      "note_not_found",
      "invalid_input",
      "invalid_input",
      "invalid_input",
      "invalid_input",
      "ok",
      "forbidden",
    ]);
    expect((d.results[0] as { text: string }).text).toBe("# A");
    expect((d.results[7] as { text: string }).text).toBe("B body");
  });

  it("keeps duplicates and the caller's ordering exactly", async () => {
    const v = vault({ "a.md": "A", "b.md": "B" });
    const uris = [uri("b.md"), uri("a.md"), uri("b.md")];
    const d = pageOf(await readPage(v, uris));
    expect(d.results.map((r) => (r.ok ? r.text : "!"))).toEqual(["B", "A", "B"]);
  });

  it("a cross-vault URI is a per-item error and does not read the other vault", async () => {
    const v = vault({ "a.md": "A" });
    const d = pageOf(await readPage(v, [uri("a.md", "other-vault"), uri("a.md")]));
    expect(codeOf(d.results[0] as Item)).toBe("forbidden");
    expect(d.results[1]?.ok).toBe(true);
  });

  it("with the central ACL stage wired, a denied URI is still a per-item error", async () => {
    const v = vault(
      { "a.md": "A", "secret/c.md": "C" },
      {
        centralAcl: true,
        acl: { readOnly: false, defaultScopes: [], rules: [], readPaths: ["a.md"] },
      },
    );
    const d = pageOf(await readPage(v, [uri("a.md"), uri("secret/c.md")]));
    expect(d.results.map((r) => (r.ok ? "ok" : r.error.code))).toEqual(["ok", "acl_denied"]);
  });

  it("refuses a caller without read:notes", async () => {
    const v = vault({ "a.md": "A" });
    const r = await readPage(v, [uri("a.md")], undefined, {
      grantedScopes: new Set(["write:notes"]),
    });
    expect(r.ok).toBe(false);
  });

  it("caps the batch at 100 URIs and rejects an empty one", async () => {
    const v = vault({ "a.md": "A" });
    const ok = await readPage(
      v,
      Array.from({ length: 100 }, () => uri("a.md")),
    );
    expect(ok.ok).toBe(true);
    const tooMany = await readPage(
      v,
      Array.from({ length: 101 }, () => uri("a.md")),
    );
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.error.code).toBe("validation_error");
    const empty = await readPage(v, []);
    expect(empty.ok).toBe(false);
  });

  it("returns the same bytes as resources/read for the same URI", async () => {
    const v = vault({ "a b/ünï.md": "# héllo\n\nbody\r\n", "n.md": "" });
    const uris = [uri("a b/ünï.md"), uri("n.md")];
    const d = pageOf(await readPage(v, uris));
    d.results.forEach((item, i) => {
      const single = readResource(v.vaultRegistry, v.ctx(), uris[i] as string, 1_000_000);
      expect(item.ok).toBe(true);
      if (!item.ok) return;
      expect({ uri: item.uri, mimeType: item.mimeType, text: item.text }).toEqual(
        single.contents[0],
      );
    });
  });

  it("reports the same error code resources/read throws, per item", async () => {
    const v = vault({ "a.md": "A" });
    for (const bad of [uri("missing.md"), "nope://x/y.md", uri("x.md", "other")]) {
      let thrown: { code?: string } = {};
      try {
        readResource(v.vaultRegistry, v.ctx(), bad, 1_000_000);
      } catch (e) {
        thrown = e as { code?: string };
      }
      const d = pageOf(await readPage(v, [bad]));
      expect(codeOf(d.results[0] as Item)).toBe(thrown.code);
    }
  });
});

describe("read_resources: byte-budget pagination", () => {
  it("returns everything with next_cursor null when the batch fits", async () => {
    const v = vault({ "a.md": "A", "b.md": "B" });
    const d = pageOf(await readPage(v, [uri("a.md"), uri("b.md")]));
    expect(d.next_cursor).toBeNull();
    expect(d.results).toHaveLength(2);
  });

  it("pages an over-budget batch: request order, no duplicate, no gap, every page under budget", async () => {
    const files: Record<string, string> = {};
    const uris: string[] = [];
    for (let i = 0; i < 8; i++) {
      files[`n${i}.md`] = `${i}:${body(400)}`;
      uris.push(uri(`n${i}.md`));
    }
    const budget = 1500;
    const v = vault(files, { maxResponseBytes: budget });
    const pages = await walk(v, uris);
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages) expect(JSON.stringify(p).length).toBeLessThanOrEqual(budget);
    const all = pages.flatMap((p) => p.results);
    expect(all.map((r) => r.uri)).toEqual(uris);
    expect(all.every((r) => r.ok)).toBe(true);
    // the governor itself never fired: no page was refused as overflow
    expect(v.events().filter((e) => e.error_code === "overflow")).toEqual([]);
  });

  it("reports an item too large for any page as too_large and moves on", async () => {
    const budget = 1500;
    const v = vault(
      { "big.md": body(1400), "huge.md": body(9000), "s.md": "small" },
      { maxResponseBytes: budget },
    );
    const uris = [uri("big.md"), uri("huge.md"), uri("s.md")];
    const pages = await walk(v, uris);
    const all = pages.flatMap((p) => p.results);
    expect(all.map((r) => r.uri)).toEqual(uris);
    expect(all.map((r) => (r.ok ? "ok" : r.error.code))).toEqual([
      "too_large", // fits the ceiling as raw bytes but not with its envelope
      "too_large", // over the ceiling outright
      "ok",
    ]);
    const huge = all[1] as Extract<Item, { ok: false }>;
    expect(huge.error.budget).toBe(budget);
    expect(huge.error.size).toBeGreaterThan(budget);
  });

  it("evaluates the folder ACL per item on resume: a URI revoked between pages is refused", async () => {
    const files: Record<string, string> = {};
    const uris: string[] = [];
    for (let i = 0; i < 6; i++) {
      files[`pub/n${i}.md`] = body(400);
      uris.push(uri(`pub/n${i}.md`));
    }
    const v = vault(files, { maxResponseBytes: 1500 });
    const first = pageOf(await readPage(v, uris));
    expect(first.next_cursor).not.toBeNull();
    const revoked = new FolderAcl({
      readOnly: false,
      defaultScopes: [],
      rules: [],
      readPaths: ["other/**"],
    } as never);
    const second = pageOf(await readPage(v, uris, first.next_cursor as string, { acl: revoked }));
    expect(second.results.length).toBeGreaterThan(0);
    expect(new Set(second.results.map(codeOf))).toEqual(new Set(["acl_denied"]));
  });

  it("binds the cursor to the caller, the tool and the exact URIs", async () => {
    const files: Record<string, string> = {};
    const uris: string[] = [];
    for (let i = 0; i < 6; i++) {
      files[`n${i}.md`] = body(400);
      uris.push(uri(`n${i}.md`));
    }
    const v = vault(files, { maxResponseBytes: 1500 });
    const first = pageOf(await readPage(v, uris));
    const cursor = first.next_cursor as string;
    const other = await readPage(v, uris.slice().reverse(), cursor);
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.error.details?.reason).toBe("request_mismatch");
    const foreign = await readPage(v, uris, cursor, { caller: "someone-else" });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.details?.reason).toBe("foreign");
    const forged = await readPage(v, uris, `${cursor.slice(0, -2)}xx`);
    expect(forged.ok).toBe(false);
  });
});
