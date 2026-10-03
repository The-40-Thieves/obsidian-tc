// The `pending` provenance record: a multi-note handler writes its intent before its first rename,
// so a crash mid-commit leaves a trail. Through the real dispatch choke point with a probe tool that
// stands in for the crash by throwing; checked against the signed, chained rows.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { ProvenanceRecorder } from "../src/provenance/recorder";
import { verifyProvenance } from "../src/provenance/verify";
import { provenanceFixture, rowsFor } from "./provenance-helpers";
import { makeTempDir, rmTemp } from "./tmp";

const root = makeTempDir("obtc-prov-pend-");
afterAll(() => rmTemp(root));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
type Fx = Awaited<ReturnType<typeof provenanceFixture>>;
const bodies = (fx: Fx) => rowsFor(fx.db).map((r) => JSON.parse(r.body));

function registryFor(fx: Fx, crash: boolean, editAfterWrite = false): ToolRegistry {
  const registry = new ToolRegistry({ provenance: fx.recorder, rootResolver: () => root });
  registry.register({
    name: "probe_batch",
    description: "test-only multi-note write",
    inputSchema: z.object({ paths: z.array(z.string()) }),
    requiredScopes: ["write:notes"],
    pathAcl: (i: { paths: string[] }) => i.paths.map((path) => ({ op: "write" as const, path })),
    handler: (i: { paths: string[] }, ctx: CallerContext) => {
      ctx.recordPendingWrite?.(new Map(i.paths.map((p) => [p, sha(`new ${p}`)])));
      mkdirSync(root, { recursive: true });
      if (crash) throw new Error("killed mid-commit");
      for (const p of i.paths) writeFileSync(join(root, p), `new ${p}`);
      if (editAfterWrite) writeFileSync(join(root, i.paths[0] as string), "concurrent edit");
      return { ok: true };
    },
  } as never);
  return registry;
}

const ctxFor = (fx: Fx): CallerContext => ({
  caller: "stdio",
  authenticated: true,
  grantedScopes: new Set(["write:notes"]),
  vaultId: "v1",
  db: fx.db,
});

describe("pending provenance records", () => {
  it("names only paths the batch will actually write", async () => {
    const fx = await provenanceFixture();
    const registry = new ToolRegistry({ provenance: fx.recorder, rootResolver: () => root });
    registry.register({
      name: "probe_skipped_patch",
      description: "test-only partial batch",
      inputSchema: z.object({}),
      requiredScopes: ["write:notes"],
      pathAcl: () => [
        { op: "write" as const, path: "written.md" },
        { op: "write" as const, path: "skipped.md" },
      ],
      handler: (_i: unknown, ctx: CallerContext) => {
        ctx.recordPendingWrite?.(new Map([["written.md", sha("written")]]));
        writeFileSync(join(root, "written.md"), "written");
        return { ok: true };
      },
    } as never);
    expect((await registry.dispatch("probe_skipped_patch", {}, ctxFor(fx))).ok).toBe(true);
    const [pending] = bodies(fx);
    expect(pending.paths).toEqual([
      { path: "written.md", before: "absent", after: sha("written") },
    ]);
  });

  it("a pending record precedes the ok record, with the hashes the call was about to write", async () => {
    const fx = await provenanceFixture();
    writeFileSync(join(root, "a.md"), "old a");
    const r = await registryFor(fx, false).dispatch(
      "probe_batch",
      { paths: ["a.md", "b.md"] },
      ctxFor(fx),
    );
    expect(r.ok).toBe(true);
    const [pending, ok] = bodies(fx);
    expect(pending).toMatchObject({ outcome: "pending", tool: "probe_batch" });
    expect(pending.paths).toEqual([
      { path: "a.md", before: sha("old a"), after: sha("new a.md") },
      { path: "b.md", before: "absent", after: sha("new b.md") },
    ]);
    expect(ok).toMatchObject({ outcome: "ok" });
    expect(ok.seq).toBe(pending.seq + 1);
    expect(ok.prev).not.toBe(pending.prev);
  });

  it("a failed call that changed nothing still answers its pending record with an error record", async () => {
    const fx = await provenanceFixture();
    const r = await registryFor(fx, true).dispatch("probe_batch", { paths: ["c.md"] }, ctxFor(fx));
    expect(r.ok).toBe(false);
    expect(bodies(fx).map((b) => b.outcome)).toEqual(["pending", "error"]);
  });

  it("settles with the batch's written digests, not bytes changed after its rename", async () => {
    const fx = await provenanceFixture();
    const r = await registryFor(fx, false, true).dispatch(
      "probe_batch",
      { paths: ["settled.md"] },
      ctxFor(fx),
    );
    expect(r.ok).toBe(true);
    const [, ok] = bodies(fx);
    expect(ok.paths).toEqual([
      { path: "settled.md", before: "absent", after: sha("new settled.md") },
    ]);
  });

  it("refuses the write when the pending provenance row cannot be recorded", async () => {
    const fx = await provenanceFixture();
    const failingDb = new Proxy(fx.db, {
      get(target, key, receiver) {
        if (key !== "prepare") return Reflect.get(target, key, receiver);
        return (sql: string) => {
          if (/INSERT INTO write_provenance/.test(sql)) throw new Error("injected sink failure");
          return target.prepare(sql);
        };
      },
    });
    const recorder = new ProvenanceRecorder({
      db: failingDb,
      host: "test-host",
      serverVersion: "test",
    });
    const path = "must-not-land.md";
    const r = await registryFor({ ...fx, recorder } as Fx, false).dispatch(
      "probe_batch",
      { paths: [path] },
      { ...ctxFor(fx), db: failingDb },
    );
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("pending provenance");
    expect(existsSync(join(root, path))).toBe(false);
  });

  it("the chain with a pending record verifies", async () => {
    const fx = await provenanceFixture();
    await registryFor(fx, false).dispatch("probe_batch", { paths: ["d.md"] }, ctxFor(fx));
    const [report] = verifyProvenance(
      fx.db,
      { resolveKey: fx.resolveKey(), allowUnsigned: false },
      "v1",
    );
    expect(report).toMatchObject({ ok: true, records: 2 });
  });

  it("without provenance wired, recordPendingWrite is absent and the handler runs normally", async () => {
    const fx = await provenanceFixture();
    const registry = new ToolRegistry({ rootResolver: () => root });
    let seen: unknown = "unset";
    registry.register({
      name: "probe_plain",
      description: "test-only",
      inputSchema: z.object({}),
      requiredScopes: ["write:notes"],
      handler: (_i: unknown, ctx: CallerContext) => {
        seen = ctx.recordPendingWrite;
        return { ok: true };
      },
    } as never);
    expect((await registry.dispatch("probe_plain", {}, ctxFor(fx))).ok).toBe(true);
    expect(seen).toBeUndefined();
  });
});
