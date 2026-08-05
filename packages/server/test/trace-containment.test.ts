// THE-737 acceptance: a session trace must never be written anywhere inside the vault.
//
// WHY THIS SHAPE, and not a unit test of `isDefaultDenied`. The ticket says so explicitly: a unit
// test of the predicate would pass against a fix that never reaches dispatch. What actually has to
// hold is a property of the SERVER — that running a session leaves no trace content under the
// vault root — so this drives the real `start_session` tool and then looks at the filesystem.
//
// It is deliberately written to compile against BOTH generations, so it can be run against `main`
// and watched failing. That means no `trace_store`, no `cacheTraceRelPath`, no branch-only symbol
// in the cross-branch assertion — only `start_session` and `v.root`.
//
// On the pre-THE-737 code this FAILS: the trace lands at `<vault>/.obsidian-tc/traces/<id>.jsonl`
// and the scan finds the sentinel. That failure is the point.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { type M5Vault, makeM5Vault } from "./m5-helpers";

/** A value that can only have come from the metadata we hand `start_session`. */
const SENTINEL = "the737-trace-containment-sentinel-8f21c4";

function data<T>(r: ToolResult): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.data as T;
}

/**
 * Every file under `dir` whose bytes contain `needle`.
 *
 * Walks dot-directories on purpose. `walkVault` skips anything starting with `.`, which is exactly
 * why the old location looked contained — a scan that inherited that rule could not see the file
 * this test exists to find.
 */
function filesContaining(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      const abs = join(d, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(abs);
      else if (st.isFile()) {
        try {
          if (readFileSync(abs, "utf8").includes(needle)) hits.push(abs);
        } catch {
          /* unreadable / binary — cannot be the JSONL trace */
        }
      }
    }
  };
  walk(dir);
  return hits;
}

let v: M5Vault | undefined;
afterEach(() => v?.cleanup());

describe("THE-737 — session traces are not vault-resident", () => {
  it("writes NO trace content anywhere under the vault root", async () => {
    v = makeM5Vault();
    const started = data<{ session_id: string; trace_path: string }>(
      await v.call("start_session", {
        vault: v.id,
        caller: "alice",
        session_metadata: { probe: SENTINEL },
      }),
    );

    // Vacuity guard. If start_session had silently stopped writing traces, the scan below would
    // pass while proving nothing — the shape this repo keeps catching (a check that measures
    // EXISTENCE rather than EFFECT). A session id and a trace path mean the write path ran.
    expect(started.session_id).toMatch(/^sess_[0-9a-f]{24}$/);
    expect(started.trace_path.length).toBeGreaterThan(0);

    // The property under test.
    expect(filesContaining(v.root, SENTINEL)).toEqual([]);
  });

  it("the trace really was written — just not in the vault", async () => {
    // The other half of the vacuity guard, and the reason the test above is not passing by
    // accident. Branch-only: `cacheDir` does not exist on the pre-THE-737 harness.
    v = makeM5Vault();
    await v.call("start_session", {
      vault: v.id,
      caller: "alice",
      session_metadata: { probe: SENTINEL },
    });
    const inCache = filesContaining(v.cacheDir, SENTINEL);
    expect(inCache).toHaveLength(1);
    expect(inCache[0]).toMatch(/\/traces\/sess_[0-9a-f]{24}\.jsonl$/);
  });

  it("end_session and get_session_traces still reach the relocated file", async () => {
    // Moving the file must not break the tools that own it — the containment is worthless if the
    // legitimate reader cannot follow.
    v = makeM5Vault();
    const started = data<{ session_id: string }>(
      await v.call("start_session", { vault: v.id, caller: "alice" }),
    );
    const traces = data<{ items: unknown[]; total_returned: number }>(
      await v.call("get_session_traces", { vault: v.id, session_id: started.session_id }),
    );
    expect(traces.items.length).toBeGreaterThan(0);
    expect(traces.total_returned).toBeGreaterThan(0);
    const ended = await v.call("end_session", { vault: v.id, session_id: started.session_id });
    expect(ended.ok).toBe(true);
  });
});
