// get_provenance: the per-note query over the write_provenance chain. Records are appended with the
// real store (signed by a real registry key), then read back through the tool as dispatch runs it.
import { afterEach, describe, expect, it } from "vitest";
import { pruneProvenance } from "../src/provenance/retention";
import { registrySignerSource } from "../src/provenance/signer";
import { CLOCK0 } from "./provenance-helpers";
import { h, moved, queryFixture } from "./provenance-query-helpers";

type Fx = Awaited<ReturnType<typeof queryFixture>>;
const open: Fx[] = [];
const make = async (...a: Parameters<typeof queryFixture>) => {
  const f = await queryFixture(...a);
  open.push(f);
  return f;
};
afterEach(() => {
  for (const f of open.splice(0)) f.cleanup();
});

interface Rec {
  seq: number;
  ts: number;
  tool: string;
  outcome: string;
  path: string;
  before?: string;
  after?: string;
  paths?: Array<{ path: string; before: string; after: string }>;
  paths_truncated?: true;
  hash?: string;
  verified: Record<string, unknown>;
  unauthenticated: Record<string, unknown>;
  self_reported: Record<string, unknown>;
  verification?: { ok: boolean; signature: string; chain_link: string; problems: string[] };
}
interface Out {
  vault: string;
  path: string;
  previous_paths: string[];
  records: Rec[];
  next_cursor: string | null;
}
async function data(f: Fx, input: Record<string, unknown>, over = {}): Promise<Out> {
  const r = await f.get(input, over);
  if (!r.ok) throw new Error(`get_provenance failed: ${JSON.stringify(r.error)}`);
  return r.data as Out;
}
const seqs = (o: Out) => o.records.map((r) => r.seq);

describe("get_provenance records", () => {
  it("returns the records touching a path, newest first, other paths excluded", async () => {
    const f = await make();
    f.add({ tool: "write_note", paths: ["a.md"] });
    f.add({ tool: "write_note", paths: ["b.md"] });
    f.add({ tool: "patch_note", paths: ["a.md"] });
    const o = await data(f, { path: "a.md" });
    expect(seqs(o)).toEqual([3, 1]);
    expect(o.records.map((r) => r.tool)).toEqual(["patch_note", "write_note"]);
    expect(o.records[0]).toMatchObject({ outcome: "ok", path: "a.md", before: h("aa") });
    expect(o.next_cursor).toBeNull();
    expect(o.previous_paths).toEqual([]);
  });

  it("keeps verified, unauthenticated and self_reported apart, never mixed", async () => {
    const f = await make();
    f.add({
      paths: ["a.md"],
      verified: { principal: "alice", persona: "editor", session_id: "s-1", transport: "http" },
      unauthenticated: {},
      self_reported: { model: "claude-x", project: "proj", client: { name: "cli", version: "2" } },
    });
    f.add({
      paths: ["a.md"],
      unauthenticated: { principal: "operator" },
      self_reported: { model: "pretends-to-be-alice", machine: "laptop" },
    });
    const [second, first] = (await data(f, { path: "a.md" })).records;
    expect(first?.verified).toEqual({
      host: "host-1",
      server_version: "1.0.0",
      transport: "http",
      principal: "alice",
      persona: "editor",
      session_id: "s-1",
    });
    expect(first?.self_reported).toEqual({
      model: "claude-x",
      project: "proj",
      client: { name: "cli", version: "2" },
    });
    expect(first?.unauthenticated).toEqual({});
    // A label the server did not verify is not in `verified`, and a claim never is.
    expect(second?.verified).not.toHaveProperty("principal");
    expect(second?.unauthenticated).toEqual({ principal: "operator" });
    expect(second?.self_reported).toEqual({ model: "pretends-to-be-alice", machine: "laptop" });
  });

  it("pages with limit and cursor without a gap or a duplicate", async () => {
    const f = await make();
    for (let i = 0; i < 5; i++) f.add({ paths: ["a.md"] });
    const p1 = await data(f, { path: "a.md", limit: 2 });
    expect(seqs(p1)).toEqual([5, 4]);
    expect(p1.next_cursor).toEqual(expect.any(String)); // opaque and signed, not a bare seq
    const p2 = await data(f, { path: "a.md", limit: 2, cursor: p1.next_cursor });
    expect(seqs(p2)).toEqual([3, 2]);
    const p3 = await data(f, { path: "a.md", limit: 2, cursor: p2.next_cursor });
    expect(seqs(p3)).toEqual([1]);
    expect(p3.next_cursor).toBeNull();
  });

  it("rejects a cursor that is not a previous next_cursor", async () => {
    const f = await make();
    f.add({ paths: ["a.md"] });
    for (const cursor of ["abc", "-1", "0", "1; DROP TABLE write_provenance"]) {
      expect((await f.get({ path: "a.md", cursor })).ok).toBe(false);
    }
  });

  it("filters by since and until (epoch ms, inclusive)", async () => {
    const f = await make();
    for (let i = 1; i <= 4; i++) f.add({ paths: ["a.md"], ts: CLOCK0 + i * 1000 });
    expect(seqs(await data(f, { path: "a.md", since: CLOCK0 + 2000 }))).toEqual([4, 3, 2]);
    expect(seqs(await data(f, { path: "a.md", until: CLOCK0 + 3000 }))).toEqual([3, 2, 1]);
    expect(
      seqs(await data(f, { path: "a.md", since: CLOCK0 + 2000, until: CLOCK0 + 3000 })),
    ).toEqual([3, 2]);
    expect(seqs(await data(f, { path: "a.md", since: CLOCK0 + 9_000 }))).toEqual([]);
  });

  it("finds a record whose stored path is a different spelling of the same note", async () => {
    const f = await make();
    f.add({ paths: ["./notes//a.md"] });
    f.add({ paths: ["notes\\a.md"] });
    f.add({ paths: ["notes/a.md"] });
    const o = await data(f, { path: "notes/a.md" });
    expect(seqs(o)).toEqual([3, 2, 1]);
    // Reported in the normalized form, whatever was stored.
    expect(o.records.every((r) => r.path === "notes/a.md")).toBe(true);
    expect(o.records.flatMap((r) => r.paths?.map((p) => p.path) ?? [])).toEqual([
      "notes/a.md",
      "notes/a.md",
      "notes/a.md",
    ]);
  });

  it("matches a non-ASCII name stored in the other Unicode form", async () => {
    const f = await make();
    f.add({ paths: ["café.md".normalize("NFD")] });
    expect(seqs(await data(f, { path: "café.md".normalize("NFC") }))).toEqual([1]);
  });

  it("a path with no record at all is not_found", async () => {
    const f = await make();
    f.add({ paths: ["a.md"] });
    const r = await f.get({ path: "never.md" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("not_found");
  });

  it("an unknown vault is an error, not an empty result", async () => {
    const f = await make();
    const r = await f.get({ path: "a.md", vault: "nope" });
    expect(r.ok).toBe(false);
  });

  it("requires read:provenance on top of read:notes", async () => {
    const f = await make();
    f.add({ paths: ["a.md"] });
    const denied = await f.get({ path: "a.md" }, { grantedScopes: new Set(["read:notes"]) });
    expect(denied.ok).toBe(false);
    const onlyProv = await f.get({ path: "a.md" }, { grantedScopes: new Set(["read:provenance"]) });
    expect(onlyProv.ok).toBe(false);
    const both = await f.get(
      { path: "a.md" },
      { grantedScopes: new Set(["read:notes", "read:provenance"]) },
    );
    expect(both.ok).toBe(true);
    const family = await f.get({ path: "a.md" }, { grantedScopes: new Set(["read:*"]) });
    expect(family.ok).toBe(true);
  });

  it("reports an error outcome and a truncated path list", async () => {
    const f = await make();
    f.add({ paths: ["a.md"], outcome: "error", omitted: 3 });
    const [rec] = (await data(f, { path: "a.md" })).records;
    expect(rec).toMatchObject({ outcome: "error", paths_truncated: true });
  });
});

describe("get_provenance response_format", () => {
  const seed = (f: Fx) =>
    f.add({
      paths: ["a.md", "b.md"],
      verified: { principal: "alice", session_id: "s-1" },
      self_reported: { model: "m", machine: "laptop", client: { name: "c" } },
    });

  it("unset, explicit detailed and the legacy full alias are identical", async () => {
    const f = await make();
    seed(f);
    const unset = await data(f, { path: "a.md" });
    expect(await data(f, { path: "a.md", response_format: "detailed" })).toEqual(unset);
    expect(await data(f, { path: "a.md", verbosity: "full" })).toEqual(unset);
    const [rec] = unset.records;
    expect(rec?.paths?.map((p) => p.path)).toEqual(["a.md", "b.md"]);
    expect(rec?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rec?.verified).toMatchObject({ host: "host-1" });
  });

  it("concise keeps attribution (still grouped) and drops host, path list, hash and machine", async () => {
    const f = await make();
    seed(f);
    const [rec] = (await data(f, { path: "a.md", response_format: "concise" })).records;
    expect(rec).toMatchObject({ seq: 1, tool: "write_note", path: "a.md" });
    expect(rec?.verified).toEqual({ principal: "alice", session_id: "s-1" });
    expect(rec?.self_reported).toEqual({ model: "m", client: { name: "c" } });
    expect(rec).not.toHaveProperty("paths");
    expect(rec).not.toHaveProperty("hash");
  });

  it("the operator default applies when the call names no format; an explicit one wins", async () => {
    const f = await make({ responseFormat: "concise" });
    seed(f);
    expect((await data(f, { path: "a.md" })).records[0]).not.toHaveProperty("paths");
    expect(
      (await data(f, { path: "a.md", response_format: "detailed" })).records[0],
    ).toHaveProperty("paths");
  });

  it("concise never trims a verification verdict", async () => {
    const f = await make();
    seed(f);
    const [rec] = (
      await data(f, { path: "a.md", response_format: "concise", include_verification: true })
    ).records;
    expect(rec?.verification).toMatchObject({ ok: true, signature: "valid" });
  });
});

describe("get_provenance follows moves backwards", () => {
  it("a note moved a -> b keeps the history of a, and says where it came from", async () => {
    const f = await make();
    f.add({ paths: ["a.md"] }); // 1 create a
    f.add({ paths: ["a.md"] }); // 2 edit a
    f.add({ tool: "move_note", paths: moved("a.md", "b.md") }); // 3
    f.add({ paths: ["b.md"] }); // 4 edit b
    f.add({ paths: ["other.md"] }); // 5 unrelated
    const o = await data(f, { path: "b.md" });
    expect(seqs(o)).toEqual([4, 3, 2, 1]);
    expect(o.previous_paths).toEqual(["a.md"]);
    // Each record says which path of the note it matched.
    expect(o.records.map((r) => r.path)).toEqual(["b.md", "b.md", "a.md", "a.md"]);
    // The move record lists both ends (both readable here).
    expect(o.records[1]?.paths?.map((p) => p.path)).toEqual(["a.md", "b.md"]);
  });

  it("does not follow forwards: the old path shows its own history up to the move", async () => {
    const f = await make();
    f.add({ paths: ["a.md"] });
    f.add({ tool: "move_note", paths: moved("a.md", "b.md") });
    f.add({ paths: ["b.md"] });
    const o = await data(f, { path: "a.md" });
    expect(seqs(o)).toEqual([2, 1]);
    expect(o.previous_paths).toEqual([]);
  });

  it("follows a chain a -> b -> c", async () => {
    const f = await make();
    f.add({ paths: ["a.md"] });
    f.add({ tool: "move_note", paths: moved("a.md", "b.md") });
    f.add({ paths: ["b.md"] });
    f.add({ tool: "move_note", paths: moved("b.md", "c.md") });
    f.add({ paths: ["c.md"] });
    const o = await data(f, { path: "c.md" });
    expect(seqs(o)).toEqual([5, 4, 3, 2, 1]);
    expect(o.previous_paths).toEqual(["b.md", "a.md"]);
  });

  it("follows a bulk move's [from, to] pairs, not its neighbours", async () => {
    const f = await make();
    f.add({ paths: ["x.md"] }); // 1
    f.add({ paths: ["y.md"] }); // 2
    f.add({
      tool: "bulk_move_notes",
      paths: [...moved("x.md", "x2.md", h("11")), ...moved("y.md", "y2.md", h("22"))],
    }); // 3
    const x = await data(f, { path: "x2.md" });
    expect(seqs(x)).toEqual([3, 1]);
    expect(x.previous_paths).toEqual(["x.md"]);
    const y = await data(f, { path: "y2.md" });
    expect(seqs(y)).toEqual([3, 2]);
    expect(y.previous_paths).toEqual(["y.md"]);
  });

  it("records of a path's previous occupant are not part of the moved note's history", async () => {
    const f = await make();
    f.add({ paths: ["b.md"] }); // 1 an older note that lived at b.md
    f.add({ paths: ["a.md"] }); // 2
    f.add({
      tool: "move_note",
      paths: [
        { path: "a.md", before: h("cc"), after: "absent" },
        { path: "b.md", before: h("aa"), after: h("cc") },
      ],
    }); // 3 overwrote b.md
    const o = await data(f, { path: "b.md" });
    expect(seqs(o)).toEqual([3, 2]);
  });

  it("a tool that is not a move is never followed, whatever its digests look like", async () => {
    const f = await make();
    f.add({ paths: ["a.md"] });
    f.add({ tool: "write_note", paths: moved("a.md", "b.md") });
    expect(seqs(await data(f, { path: "b.md" }))).toEqual([2]);
  });

  it("a move back (a -> b -> a) terminates", async () => {
    const f = await make();
    f.add({ paths: ["a.md"] });
    f.add({ tool: "move_note", paths: moved("a.md", "b.md") });
    f.add({ tool: "move_note", paths: moved("b.md", "a.md") });
    expect(seqs(await data(f, { path: "a.md" }))).toEqual([3, 2, 1]);
  });

  it("pages across the lineage boundary", async () => {
    const f = await make();
    f.add({ paths: ["a.md"] });
    f.add({ tool: "move_note", paths: moved("a.md", "b.md") });
    f.add({ paths: ["b.md"] });
    const p1 = await data(f, { path: "b.md", limit: 2 });
    expect(seqs(p1)).toEqual([3, 2]);
    const p2 = await data(f, { path: "b.md", limit: 2, cursor: p1.next_cursor });
    expect(seqs(p2)).toEqual([1]);
  });
});

describe("get_provenance include_verification", () => {
  const verifyOf = async (f: Fx, seq: number) =>
    (await data(f, { path: "a.md", include_verification: true })).records.find((r) => r.seq === seq)
      ?.verification;

  it("omits the key unless asked", async () => {
    const f = await make();
    f.add({ paths: ["a.md"] });
    expect((await data(f, { path: "a.md" })).records[0]).not.toHaveProperty("verification");
  });

  it("an intact signed record verifies: valid signature, ok chain link", async () => {
    const f = await make();
    f.add({ paths: ["a.md"] });
    f.add({ paths: ["a.md"] });
    expect(await verifyOf(f, 1)).toEqual({
      ok: true,
      signature: "valid",
      chain_link: "ok",
      problems: [],
    });
    expect(await verifyOf(f, 2)).toMatchObject({ ok: true, chain_link: "ok" });
  });

  it("an edited record is flagged: its body no longer matches its hash", async () => {
    const f = await make();
    f.add({ paths: ["a.md"], self_reported: { model: "honest" } });
    f.tv.db
      .prepare("UPDATE write_provenance SET body = replace(body, 'honest', 'forged') WHERE seq = 1")
      .run();
    const v = await verifyOf(f, 1);
    expect(v?.ok).toBe(false);
    expect(v?.problems).toContain("hash_mismatch");
  });

  it("a forged signature is invalid", async () => {
    const f = await make();
    f.add({ paths: ["a.md"] });
    const sig = (f.tv.db.prepare("SELECT sig FROM write_provenance").get() as { sig: string }).sig;
    const flipped = (sig.startsWith("A") ? "B" : "A") + sig.slice(1);
    f.tv.db.prepare("UPDATE write_provenance SET sig = ?").run(flipped);
    expect(await verifyOf(f, 1)).toMatchObject({ ok: false, signature: "invalid" });
  });

  it("a removed predecessor breaks the chain link", async () => {
    const f = await make();
    f.add({ paths: ["z.md"] });
    f.add({ paths: ["a.md"] });
    f.tv.db.prepare("DELETE FROM write_provenance WHERE seq = 1").run();
    expect(await verifyOf(f, 2)).toMatchObject({ ok: false, chain_link: "broken" });
  });

  it("a record rewritten to chain from somewhere else breaks the link", async () => {
    const f = await make();
    f.add({ paths: ["z.md"] });
    f.add({ paths: ["a.md"] });
    f.tv.db.prepare("UPDATE write_provenance SET prev_hash = ? WHERE seq = 2").run(h("dead"));
    const v = await verifyOf(f, 2);
    expect(v?.chain_link).toBe("broken");
    expect(v?.ok).toBe(false);
  });

  it("the first record that survives a prune still links to the signed anchor", async () => {
    const f = await make();
    for (let i = 0; i < 3; i++) f.add({ paths: ["a.md"], ts: CLOCK0 + 1000 * (i + 1) });
    const signer = registrySignerSource(f.fx.registry)();
    expect(pruneProvenance(f.tv.db, f.tv.id, CLOCK0 + 2500, signer)).toBe(2);
    expect(await verifyOf(f, 3)).toMatchObject({ ok: true, chain_link: "ok" });
  });

  it("an unsigned record is reported unsigned, not valid", async () => {
    const f = await make({ signed: false });
    f.add({ paths: ["a.md"] });
    expect(await verifyOf(f, 1)).toEqual({
      ok: false,
      signature: "unsigned",
      chain_link: "ok",
      problems: ["unsigned"],
    });
  });

  it("with no key registry a signed record is unverifiable, never valid", async () => {
    const f = await make({ provenanceKeys: () => undefined });
    f.add({ paths: ["a.md"] });
    const v = await verifyOf(f, 1);
    expect(v).toMatchObject({ ok: false, signature: "unverifiable", chain_link: "ok" });
    expect(v?.problems).toEqual([]);
  });

  it("a key the registry never held is unknown_key", async () => {
    const f = await make({ provenanceKeys: () => () => undefined });
    f.add({ paths: ["a.md"] });
    expect(await verifyOf(f, 1)).toMatchObject({ ok: false, signature: "unknown_key" });
  });

  it("a registry that throws reads as unverifiable, not as tampering", async () => {
    const f = await make({
      provenanceKeys: () => {
        throw new Error("registry lost");
      },
    });
    f.add({ paths: ["a.md"] });
    expect(await verifyOf(f, 1)).toMatchObject({ signature: "unverifiable", chain_link: "ok" });
  });
});
