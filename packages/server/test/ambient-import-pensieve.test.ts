// THE-175 — source-agnostic ambient-capture format + Pensieve adapter, staged via capture_queue.
//
// Integration-shaped: a fixture Pensieve `/api/search` response (the real
// hits[].document.metadata_entries shape, verified against github.com/arkohut/pensieve's
// memos/server.py + memos/schemas.py) goes through fetchPensieveObservations, then ingestAmbient,
// and lands as capture_queue rows with source: "ambient" — the same reviewable staging path
// THE-855's poison scan already covers for every enqueue. A second poll over the same fixture must
// dedup: zero new rows, every observation reported skipped_duplicate. A fixture observation
// carrying a fake AWS key must never reach capture_queue's stored content.
import { describe, expect, it } from "vitest";
import {
  AMBIENT_DEDUPE_TAG_PREFIX,
  ambientDedupeKey,
  ingestAmbient,
} from "../src/capture/ambient-import";
import { fetchPensieveObservations, PensieveApiError } from "../src/capture/pensieve";
import { listCaptures } from "../src/capture/queue";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { openMemoryDb } from "./helpers";
import { makeM5Vault } from "./m5-helpers";

function cacheDb(): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  return db;
}

// A trimmed real `/api/search` response shape: two entities with usable OCR text, one with only
// low-confidence OCR lines (must be dropped), one with no ocr_result at all (must be dropped).
function searchFixture() {
  return {
    hits: [
      {
        document: {
          id: "101",
          file_created_at: "2026-08-10T09:00:00Z",
          metadata_entries: [
            { key: "active_app", value: "Terminal", source: "record" },
            { key: "active_window", value: "zsh — obsidian-tc", source: "record" },
            {
              key: "ocr_result",
              value: [
                { rec_txt: "$ bun run test:local", score: 0.98 },
                { rec_txt: "42 passed", score: 0.91 },
              ],
              source: "ocr",
            },
          ],
        },
      },
      {
        document: {
          id: "102",
          file_created_at: "2026-08-10T09:05:00Z",
          metadata_entries: [
            { key: "active_app", value: "Chrome", source: "record" },
            { key: "active_window", value: "AWS Console — IAM", source: "record" },
            { key: "url", value: "https://console.aws.amazon.com/iam", source: "record" },
            {
              key: "ocr_result",
              value: [
                // Fake, obviously-not-real AWS access key id — must be redacted before it ever
                // reaches capture_queue's stored content.
                { rec_txt: "Access key: AKIAABCDEFGHIJKLMNOP", score: 0.95 },
              ],
              source: "ocr",
            },
          ],
        },
      },
      {
        // Only a low-confidence OCR line (below the plugin's own 0.5 threshold) -> no usable text.
        document: {
          id: "103",
          file_created_at: "2026-08-10T09:10:00Z",
          metadata_entries: [
            { key: "active_app", value: "Preview", source: "record" },
            { key: "ocr_result", value: [{ rec_txt: "blurry", score: 0.2 }], source: "ocr" },
          ],
        },
      },
      {
        // No ocr_result metadata entry at all (not yet processed).
        document: {
          id: "104",
          file_created_at: "2026-08-10T09:15:00Z",
          metadata_entries: [{ key: "active_app", value: "Finder", source: "record" }],
        },
      },
    ],
  };
}

function fakePensieveFetch(): typeof fetch {
  const calls: string[] = [];
  const impl = (async (url: string | URL) => {
    calls.push(url.toString());
    return new Response(JSON.stringify(searchFixture()), { status: 200 });
  }) as unknown as typeof fetch;
  (impl as unknown as { calls: string[] }).calls = calls;
  return impl;
}

describe("THE-175 Pensieve adapter -> canonical model", () => {
  it("maps /api/search hits, applies the OCR score threshold, and drops entities with no usable text", async () => {
    const fetchFn = fakePensieveFetch();
    const items = await fetchPensieveObservations("http://pensieve.example:8839", {
      machine: "workstation-1",
      fetchFn,
    });

    // Entities 103 (all low-confidence OCR) and 104 (no ocr_result) are dropped entirely.
    expect(items.map((i) => i.captured_at).sort()).toStrictEqual([
      "2026-08-10T09:00:00Z",
      "2026-08-10T09:05:00Z",
    ]);

    const terminal = items.find((i) => i.captured_at === "2026-08-10T09:00:00Z");
    expect(terminal).toMatchObject({
      source: "pensieve",
      machine: "workstation-1",
      app: "Terminal",
      window_title: "zsh — obsidian-tc",
    });
    expect(terminal?.text).toBe("$ bun run test:local\n42 passed");
    expect(terminal?.url).toBeUndefined();

    const aws = items.find((i) => i.captured_at === "2026-08-10T09:05:00Z");
    expect(aws?.url).toBe("https://console.aws.amazon.com/iam");
    expect(aws?.text).toContain("AKIAABCDEFGHIJKLMNOP"); // adapter maps raw text; redaction is ingestAmbient's job

    const calls = (fetchFn as unknown as { calls: string[] }).calls;
    expect(calls).toHaveLength(1);
    const requested = new URL(calls[0] as string);
    expect(requested.pathname).toBe("/api/search");
    expect(requested.searchParams.get("q")).toBe("");
  });

  it("passes --since through as epoch-seconds `start`", async () => {
    const fetchFn = fakePensieveFetch();
    await fetchPensieveObservations("http://pensieve.example:8839", {
      machine: "workstation-1",
      since: "2026-08-10T09:00:00.000Z",
      fetchFn,
    });
    const calls = (fetchFn as unknown as { calls: string[] }).calls;
    const requested = new URL(calls[0] as string);
    expect(requested.searchParams.get("start")).toBe("1786352400");
  });

  it("clamps limit to the API's own [1, 200] ceiling", async () => {
    const fetchFn = fakePensieveFetch();
    await fetchPensieveObservations("http://pensieve.example:8839", {
      machine: "workstation-1",
      limit: 9999,
      fetchFn,
    });
    const calls = (fetchFn as unknown as { calls: string[] }).calls;
    const requested = new URL(calls[0] as string);
    expect(requested.searchParams.get("limit")).toBe("200");
  });

  it("surfaces a non-2xx as PensieveApiError with the status attached", async () => {
    const fetchFn = (async () =>
      new Response("not found", {
        status: 404,
        statusText: "Not Found",
      })) as unknown as typeof fetch;
    await expect(
      fetchPensieveObservations("http://pensieve.example:8839", {
        machine: "workstation-1",
        fetchFn,
      }),
    ).rejects.toBeInstanceOf(PensieveApiError);
    try {
      await fetchPensieveObservations("http://pensieve.example:8839", {
        machine: "workstation-1",
        fetchFn,
      });
      throw new Error("expected rejection");
    } catch (e) {
      expect(e).toBeInstanceOf(PensieveApiError);
      expect((e as PensieveApiError).status).toBe(404);
    }
  });
});

describe("THE-175 ingestAmbient -> capture_queue", () => {
  it("enqueues one capture per observation, source: ambient, redacts secrets, and dedups on re-poll", async () => {
    const db = cacheDb();
    const fetchFn = fakePensieveFetch();
    const items = await fetchPensieveObservations("http://pensieve.example:8839", {
      machine: "workstation-1",
      fetchFn,
    });
    expect(items).toHaveLength(2);

    const first = ingestAmbient(db, "main", items, 1000);
    expect(first).toStrictEqual({ enqueued: 2, skipped_duplicate: 0, redacted: 1 });

    const rows = listCaptures(db, "main", { source: "ambient" });
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.source).toBe("ambient");
      expect(r.committed_at).toBeNull();
    }

    // The AWS-key observation's stored content never carries the raw secret.
    const awsRow = rows.find((r) => r.title === "AWS Console — IAM");
    expect(awsRow?.content).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(awsRow?.content).toContain("[REDACTED]");
    expect(awsRow?.tags).toContain("ambient");
    expect(awsRow?.tags).toContain("pensieve");
    expect(awsRow?.tags).toContain("machine:workstation-1");
    expect(awsRow?.tags).toMatch(/ambient-dedupe:[0-9a-f]{32}/);

    const terminalRow = rows.find((r) => r.title === "zsh — obsidian-tc");
    expect(terminalRow?.content).toContain("bun run test:local");

    // Re-run over the SAME fetched items (simulating a re-poll): nothing new enqueued.
    const second = ingestAmbient(db, "main", items, 2000);
    expect(second).toStrictEqual({ enqueued: 0, skipped_duplicate: 2, redacted: 0 });
    expect(listCaptures(db, "main", { source: "ambient" })).toHaveLength(2);
  });

  it("a duplicate is still skipped after the original capture is committed", async () => {
    const db = cacheDb();
    const fetchFn = fakePensieveFetch();
    const items = await fetchPensieveObservations("http://pensieve.example:8839", {
      machine: "workstation-1",
      fetchFn,
    });
    ingestAmbient(db, "main", items, 1000);
    const [row] = listCaptures(db, "main", { source: "ambient" });
    if (!row) throw new Error("expected a staged row");
    db.prepare("UPDATE capture_queue SET committed_at = ?, committed_path = ? WHERE id = ?").run(
      1500,
      "/inbox/committed.md",
      row.id,
    );

    const rerun = ingestAmbient(db, "main", items, 2000);
    expect(rerun.skipped_duplicate).toBe(2);
    expect(rerun.enqueued).toBe(0);
  });

  it("--dry-run reports counts (including WOULD-redact) and enqueues nothing", async () => {
    const db = cacheDb();
    const fetchFn = fakePensieveFetch();
    const items = await fetchPensieveObservations("http://pensieve.example:8839", {
      machine: "workstation-1",
      fetchFn,
    });
    const result = ingestAmbient(db, "main", items, 1000, { dryRun: true });
    expect(result).toStrictEqual({ enqueued: 2, skipped_duplicate: 0, redacted: 1 });
    expect(listCaptures(db, "main", { source: "ambient" })).toHaveLength(0);
  });

  it("dedupes on (source, machine, app, text) — not on window_title or captured_at", () => {
    const db = cacheDb();
    const now = 1000;
    const base = {
      source: "pensieve",
      machine: "workstation-1",
      app: "Terminal",
      text: "$ ls -la",
      url: undefined,
    };
    const first = ingestAmbient(
      db,
      "main",
      [{ ...base, window_title: "zsh", captured_at: "2026-08-10T09:00:00Z" }],
      now,
    );
    expect(first).toStrictEqual({ enqueued: 1, skipped_duplicate: 0, redacted: 0 });

    // Same (source, machine, app, text) but a DIFFERENT window_title and captured_at — still dedups.
    const second = ingestAmbient(
      db,
      "main",
      [{ ...base, window_title: "bash", captured_at: "2026-08-10T09:05:00Z" }],
      now + 1000,
    );
    expect(second).toStrictEqual({ enqueued: 0, skipped_duplicate: 1, redacted: 0 });

    // A different app on the same machine, same text -> a distinct key.
    const differentApp = ambientDedupeKey({ ...base, app: "iTerm" });
    const sameApp = ambientDedupeKey(base);
    expect(differentApp).not.toBe(sameApp);
  });
});

// THE-175 — the `ambient-dedupe:<hash>` tag ambient-import.ts stamps for its own re-poll lookup
// must never reach a human reviewer or a committed note's frontmatter, mirroring THE-650's
// import-dedupe check. Exercised end-to-end through the real MCP tools, not just the filter
// function directly.
describe("THE-175 the ambient dedupe tag stays internal (never surfaces via the MCP tools)", () => {
  it("list_capture_queue hides it, and commit_capture never writes it into frontmatter", async () => {
    const v = makeM5Vault();
    try {
      const dedupeTag = `${AMBIENT_DEDUPE_TAG_PREFIX}deadbeefdeadbeefdeadbeefdeadbeef`;
      const enq = await v.call("enqueue_capture", {
        vault: "test",
        content: "$ bun run test:local\n42 passed",
        title: "zsh — obsidian-tc",
        tags: ["ambient", "pensieve", "machine:workstation-1", dedupeTag],
        source: "ambient",
      });
      if (!enq.ok) throw new Error("enqueue failed");
      const captureId = (enq.data as { capture_id: string }).capture_id;

      const listed = await v.call("list_capture_queue", { vault: "test", source: "ambient" });
      if (!listed.ok) throw new Error("list failed");
      const item = (listed.data as { items: Array<{ tags: string[] }> }).items[0];
      expect(item?.tags).toStrictEqual(["ambient", "pensieve", "machine:workstation-1"]);
      expect(item?.tags).not.toContain(dedupeTag);

      const committed = await v.call("commit_capture", {
        vault: "test",
        capture_id: captureId,
        target_path: "inbox/terminal.md",
      });
      expect(committed.ok).toBe(true);
      const note = v.read("inbox/terminal.md");
      expect(note).toContain("ambient");
      expect(note).toContain("pensieve");
      expect(note).not.toContain(AMBIENT_DEDUPE_TAG_PREFIX);
    } finally {
      v.cleanup();
    }
  });
});
