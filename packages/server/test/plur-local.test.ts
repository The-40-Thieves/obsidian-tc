import { describe, expect, it } from "vitest";
import { createLocalPlurClient, type PlurExec } from "../src/plur/local";

// A fake exec that records the argv and returns canned stdout keyed by the CLI verb.
function fakeExec(byVerb: Record<string, unknown>, seen: string[][]): PlurExec {
  return (argv) => {
    seen.push(argv);
    const verb = argv[0] ?? "";
    const payload = byVerb[verb];
    if (payload === undefined)
      return Promise.resolve({ code: 1, stdout: '{"error":"no route"}', stderr: "" });
    if (typeof payload === "string")
      return Promise.resolve({ code: 0, stdout: payload, stderr: "" });
    return Promise.resolve({ code: 2, stdout: JSON.stringify(payload), stderr: "" });
  };
}

describe("THE-208 local plur bridge", () => {
  it("plur_recall -> `recall --fast`; plur_recall_hybrid -> default (no --fast)", async () => {
    const seen: string[][] = [];
    const exec = fakeExec(
      { recall: { results: [{ id: "E1", statement: "s", scope: "global" }], count: 1 } },
      seen,
    );
    const c = createLocalPlurClient({ command: ["plur"], exec });

    const r1 = await c.request<{ results: unknown[] }>({
      method: "POST",
      path: "/recall",
      body: { query: "q", k: 5 },
      plugin: "plur",
    });
    expect(seen[0]).toEqual(["recall", "q", "--limit", "5", "--json", "--fast"]);
    expect(r1.results).toHaveLength(1);

    await c.request({
      method: "POST",
      path: "/recall_hybrid",
      body: { query: "q", k: 3 },
      plugin: "plur",
    });
    expect(seen[1]).toEqual(["recall", "q", "--limit", "3", "--json"]);
    expect(seen[1]).not.toContain("--fast");
  });

  it("scope filters recall client-side; similarity passes --scope and filters min_score", async () => {
    const seen: string[][] = [];
    const exec = fakeExec(
      {
        recall: {
          results: [
            { id: "A", statement: "a", scope: "team" },
            { id: "B", statement: "b", scope: "global" },
          ],
          count: 2,
        },
        "similarity-search": {
          results: [
            { id: "A", statement: "a", cosine_score: 0.9 },
            { id: "B", statement: "b", cosine_score: 0.3 },
          ],
          count: 2,
        },
      },
      seen,
    );
    const c = createLocalPlurClient({ command: ["plur"], exec });

    const scoped = await c.request<{ results: Array<{ id: string }> }>({
      method: "POST",
      path: "/recall",
      body: { query: "q", k: 10, scope: "team" },
      plugin: "plur",
    });
    expect(scoped.results.map((r) => r.id)).toEqual(["A"]);

    const sim = await c.request<{ results: Array<{ id: string }> }>({
      method: "POST",
      path: "/similarity_search",
      body: { query: "q", k: 10, scope: "team", min_score: 0.5 },
      plugin: "plur",
    });
    expect(seen[1]).toEqual([
      "similarity-search",
      "q",
      "--limit",
      "10",
      "--json",
      "--scope",
      "team",
    ]);
    expect(sim.results.map((r) => r.id)).toEqual(["A"]); // B (0.3) filtered by min_score
  });

  it("plur_get lists and filters by id", async () => {
    const seen: string[][] = [];
    const exec = fakeExec(
      {
        list: {
          engrams: [
            { id: "X", statement: "x" },
            { id: "Y", statement: "y" },
          ],
          count: 2,
        },
      },
      seen,
    );
    const c = createLocalPlurClient({ command: ["plur"], exec });
    const hit = await c.request<{ found: boolean; engram: { id: string } | null }>({
      method: "POST",
      path: "/get",
      body: { engram_id: "Y" },
      plugin: "plur",
    });
    expect(hit.found).toBe(true);
    expect(hit.engram?.id).toBe("Y");
    const miss = await c.request<{ found: boolean }>({
      method: "POST",
      path: "/get",
      body: { engram_id: "Z" },
      plugin: "plur",
    });
    expect(miss.found).toBe(false);
  });

  it("degrades to plugin_unreachable on non-JSON CLI output", async () => {
    const c = createLocalPlurClient({
      command: ["plur"],
      exec: () => Promise.resolve({ code: 0, stdout: "not json at all", stderr: "" }),
    });
    await expect(
      c.request({ method: "POST", path: "/recall", body: { query: "q", k: 1 }, plugin: "plur" }),
    ).rejects.toMatchObject({ code: "plugin_unreachable" });
  });
});

describe("THE-208 createPlurBackend selection", () => {
  it("command -> local CLI; endpoint -> http; neither -> undefined", async () => {
    const { createPlurBackend } = await import("../src/plur/client");
    expect(createPlurBackend({ command: ["plur"] })).toBeDefined();
    expect(createPlurBackend({ endpoint: "http://127.0.0.1:7077" })).toBeDefined();
    expect(createPlurBackend({})).toBeUndefined();
    expect(createPlurBackend(undefined)).toBeUndefined();
  });
});
