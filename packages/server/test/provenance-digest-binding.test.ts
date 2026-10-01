// A record's `after` digest must describe THIS write, and a digest must never be taken from a file
// outside the vault. Two holes the first version had: the after-digest was re-read from disk after
// the handler returned (a concurrent writer could plant bytes in that window and get them signed
// under the victim's name), and `O_NOFOLLOW` only guards the leaf, so a directory swapped for a
// symlink between the containment check and the open made `open` follow it out of the vault.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { provenanceCheck } from "../src/doctor/provenance";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { digestUnder } from "../src/provenance/digest";
import { ProvenanceRecorder } from "../src/provenance/recorder";
import { registrySignerSource } from "../src/provenance/signer";
import { appendProvenance } from "../src/provenance/store";
import { PROVENANCE_FAULT_EVENT } from "../src/provenance/types";
import { CLOCK0, provenanceFixture, rowsFor } from "./provenance-helpers";
import { rmTemp } from "./tmp";

const root = mkdtempSync(join(tmpdir(), "obtc-prov-bind-"));
const outside = mkdtempSync(join(tmpdir(), "obtc-prov-bind-out-"));
afterAll(() => {
  rmTemp(root);
  rmTemp(outside);
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
type Fx = Awaited<ReturnType<typeof provenanceFixture>>;
const records = (fx: Fx) => rowsFor(fx.db).map((r) => JSON.parse(r.body));
const ctxFor = (fx: Fx): CallerContext => ({
  caller: "stdio",
  authenticated: true,
  grantedScopes: new Set(["write:notes"]),
  vaultId: "v1",
  db: fx.db,
});

describe("digestUnder: the opened file must be the vetted one", () => {
  it("control: a plain in-vault file is hashed", async () => {
    writeFileSync(join(root, "plain.md"), "plain");
    expect(await digestUnder(root, "plain.md")).toBe(sha("plain"));
  });

  it("a directory swapped for a symlink OUT of the vault between check and open is `unhashable`", async () => {
    mkdirSync(join(root, "swap"), { recursive: true });
    writeFileSync(join(root, "swap", "note.md"), "inside");
    mkdirSync(join(outside, "swapped"), { recursive: true });
    const secret = "outside-bytes-that-must-never-be-hashed";
    writeFileSync(join(outside, "swapped", "note.md"), secret);
    const digest = await digestUnder(root, "swap/note.md", {
      afterCheck: () => {
        renameSync(join(root, "swap"), join(root, "swap.real"));
        symlinkSync(join(outside, "swapped"), join(root, "swap"));
      },
    });
    expect(digest).toBe("unhashable");
    expect(digest).not.toBe(sha(secret));
  });
});

describe("the after-digest is bound to the write", () => {
  const probe = (fx: Fx, result: (content: string) => unknown) => {
    const reg = new ToolRegistry({ provenance: fx.recorder, rootResolver: () => root });
    reg.register({
      name: "probe_hash",
      description: "test-only",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      requiredScopes: ["write:notes"],
      pathAcl: (i: { path: string }) => [{ op: "write" as const, path: i.path }],
      handler: (i: { path: string; content: string }) => {
        writeFileSync(join(root, i.path), i.content);
        return result(i.content);
      },
    } as never);
    return reg;
  };

  it("uses the content_hash the handler returned, end to end through dispatch", async () => {
    const fx = await provenanceFixture();
    const reg = probe(fx, (c) => ({ path: "bound.md", content_hash: sha(c) }));
    await reg.dispatch("probe_hash", { path: "bound.md", content: "mine" }, ctxFor(fx));
    expect(records(fx)[0].paths).toEqual([
      { path: "bound.md", before: "absent", after: sha("mine") },
    ]);
  });

  it("a file replaced after the handler returned is NOT what gets signed", async () => {
    const fx = await provenanceFixture();
    const def = { name: "w", pathAcl: () => [{ op: "write", path: "race.md" }] };
    const pending = await fx.recorder.begin(def as never, {}, ctxFor(fx), root);
    writeFileSync(join(root, "race.md"), "mine");
    writeFileSync(join(root, "race.md"), "planted-by-a-concurrent-writer"); // the TOCTOU window
    await fx.recorder.commit(pending, "ok", { path: "race.md", content_hash: sha("mine") });
    expect(records(fx)[0].paths[0].after).toBe(sha("mine"));
  });

  it("falls back to the disk read when the result names another path, or carries no usable hash", async () => {
    const fx = await provenanceFixture();
    const def = { name: "w", pathAcl: () => [{ op: "write", path: "fb.md" }] };
    for (const result of [
      { path: "other.md", content_hash: sha("x") },
      { path: "fb.md", content_hash: "not-a-hash" },
      { content_hash: sha("x") },
      "string result",
      undefined,
    ]) {
      const pending = await fx.recorder.begin(def as never, {}, ctxFor(fx), root);
      writeFileSync(join(root, "fb.md"), "on-disk");
      await fx.recorder.commit(pending, "ok", result);
    }
    for (const r of records(fx)) expect(r.paths[0].after).toBe(sha("on-disk"));
  });

  it("is not used for a call that names several paths", async () => {
    const fx = await provenanceFixture();
    const def = {
      name: "w",
      pathAcl: () => [
        { op: "write", path: "m1.md" },
        { op: "write", path: "m2.md" },
      ],
    };
    const pending = await fx.recorder.begin(def as never, {}, ctxFor(fx), root);
    writeFileSync(join(root, "m1.md"), "one");
    writeFileSync(join(root, "m2.md"), "two");
    await fx.recorder.commit(pending, "ok", { path: "m1.md", content_hash: sha("wrong") });
    expect(records(fx)[0].paths.map((p: { after: string }) => p.after)).toEqual([
      sha("one"),
      sha("two"),
    ]);
  });
});

describe("a recording fault is visible, not silent", () => {
  const faulting = async () => {
    const fx = await provenanceFixture();
    const counted: string[] = [];
    const recorder = new ProvenanceRecorder({
      db: fx.db,
      host: "h",
      serverVersion: "0",
      now: () => CLOCK0,
      signer: registrySignerSource(fx.registry),
      metrics: { incFault: (v, t, k) => counted.push(`${v}/${t}/${k}`) },
      onError: () => undefined,
    });
    return { fx, recorder, counted };
  };
  const events = (fx: Fx) =>
    fx.db
      .prepare("SELECT error_code, tool_name FROM event_log WHERE event_type = ?")
      .all(PROVENANCE_FAULT_EVENT) as Array<{ error_code: string; tool_name: string }>;
  const def = { name: "write_note", pathAcl: () => [{ op: "write", path: "f.md" }] };

  it("an omitted record is counted and leaves an event_log row, and the write is not failed", async () => {
    const { fx, recorder, counted } = await faulting();
    fx.db.exec("DROP TABLE write_provenance_heads");
    const pending = await recorder.begin(def as never, {}, ctxFor(fx), root);
    await expect(recorder.commit(pending, "ok")).resolves.toBeUndefined();
    expect(counted).toEqual(["v1/write_note/omitted"]);
    expect(events(fx)).toEqual([{ error_code: "provenance_omitted", tool_name: "write_note" }]);
  });

  it("a record written over a failed head is counted as head_untrusted", async () => {
    const { fx, recorder, counted } = await faulting();
    const append = () =>
      appendProvenance(
        fx.db,
        {
          vaultId: "v1",
          ts: CLOCK0,
          tool: "t",
          outcome: "ok",
          paths: [],
          pathsOmitted: 0,
          verified: { host: "h", server_version: "0" },
          unauthenticated: {},
          self_reported: {},
        },
        registrySignerSource(fx.registry)(),
      );
    append();
    append();
    fx.db.prepare("DELETE FROM write_provenance WHERE seq = 2").run();
    const pending = await recorder.begin(def as never, {}, ctxFor(fx), root);
    await recorder.commit(pending, "ok");
    expect(counted).toEqual(["v1/write_note/head_untrusted"]);
    expect(events(fx)[0]?.error_code).toBe("provenance_head_untrusted");
  });

  it("doctor warns (never ok) when an omission is on file, even though the chain verifies", async () => {
    const view = {
      enabled: true,
      registryState: "ok" as const,
      signingKeyActive: true,
      vaults: [{ vault: "v1", records: 2, signed: 2, unsigned: 0, problems: [] }],
      faults: { omitted: 2, headUntrusted: 0 },
    };
    const r = await provenanceCheck(view).run({ serverVersion: "test" });
    expect(r.status).toBe("warning");
    expect(r.summary).toContain("2 committed writes left no record");
  });
});
