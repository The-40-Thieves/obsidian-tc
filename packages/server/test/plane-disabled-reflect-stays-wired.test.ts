// THE-822 follow-up — closes acceptance criterion 4's coverage gap: nothing asserted "gateway
// present, plane off, reflect still functional". THE-822 gated createOnIndexedHook and
// wireJobHandlers on plane.enabled at server-runtime.ts's call site (~421-531), but left
// wireDomainTools's `roles` deliberately UNGATED — see plane.schema.ts's own comment: "[enabled:
// false] does NOT gate `roles` itself, which stays live for other tools (e.g. reflect) regardless
// of this flag." createOnIndexedHook/wireJobHandlers's own gating is already covered directly, at
// the unit level, by plane-enabled-gates-ingest-and-jobs.test.ts — that IS the call site for those
// two, since the `plane.enabled` check lives inside the functions themselves.
//
// wireDomainTools is different: it takes no `plane` dep at all (tools/m7/knowledge/deps.ts), so
// the asymmetry lives entirely at server-runtime.ts's CALL SITE, which decides whether to pass the
// full `roles` or a gated one. A unit test constructing wireDomainTools directly would pass even if
// a future "simplification" nulled `roles` before that call — it would just be testing a value the
// test itself chose. This test goes through `buildServerRuntime`, the actual composition root, so
// a regression like `roles: config.plane.enabled ? roles : null` at that call site is what makes it
// fail (verified by hand — see the task's watched-failure output).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configFromVaultPath } from "../src/cli/args";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { buildServerRuntime } from "../src/runtime/server-runtime";
import { openMemoryDb } from "./helpers";
import { rmTemp } from "./tmp";

const ENV_URL = "OBSIDIAN_TC_GATEWAY_URL";

let savedUrl: string | undefined;
let savedFetch: typeof globalThis.fetch;

beforeEach(() => {
  savedUrl = process.env[ENV_URL];
  savedFetch = globalThis.fetch;
  // Any non-empty base URL makes wireGatewaySeams's createGatewayClient({}) succeed, which is all
  // it takes for `roles` to resolve non-null (tool-wiring.ts's wireGatewaySeams) — no real network
  // reachability is required until something actually calls it.
  process.env[ENV_URL] = "http://gateway.invalid";
});

afterEach(() => {
  if (savedUrl === undefined) delete process.env[ENV_URL];
  else process.env[ENV_URL] = savedUrl;
  globalThis.fetch = savedFetch;
});

/** A canned `/chat/completions` 200 — real `synthesize()` parses `choices[0].message.content` and
 *  `model` (gateway/client.ts's `complete`). Any other path throws, so a regression that routes
 *  reflect through some other seam is visible rather than silently accepted. Same
 *  globalThis.fetch-swap idiom as plane-gateway-timeout.test.ts (THE-709). */
function stubChatFetch(): typeof globalThis.fetch {
  return (async (url: unknown) => {
    if (!String(url).endsWith("/chat/completions")) {
      throw new Error(`unexpected gateway call: ${String(url)}`);
    }
    return new Response(
      JSON.stringify({
        model: "stub-synth-model",
        choices: [{ message: { content: "the stubbed answer" }, finish_reason: "stop" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
}

function un<T>(r: unknown): T {
  return (r as { data: T }).data;
}

interface ReflectData {
  mode: string;
  available: boolean;
  answer?: string | null;
  message?: string;
  sources: Array<{ chunk_id: string; path: string }>;
}

describe("THE-822 follow-up: plane disabled + gateway configured -> reflect stays wired (buildServerRuntime call site)", () => {
  const tmpDirs: string[] = [];
  const tmpDir = (prefix: string): string => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
  };

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      try {
        rmTemp(d);
      } catch {
        // Best-effort, matching server-runtime.test.ts's own concession: a still-open sqlite
        // handle can make Windows refuse the unlink; the assertions under test have already run.
      }
    }
  });

  it("reflect runs a real synthesis pass (available: true, live gateway) with plane.enabled: false", async () => {
    globalThis.fetch = stubChatFetch();

    const vaultDir = tmpDir("otc-plane-disabled-vault-");
    const config = configFromVaultPath(vaultDir);
    config.cacheDir = tmpDir("otc-plane-disabled-cache-");
    // The exact scenario THE-822's acceptance criterion 4 named: plane OFF, gateway present.
    config.plane.enabled = false;
    // Deterministic lexical routing — a quoted phrase short-circuits routeQuery to "lexical"
    // (search/router.ts) so this test never touches the embeddings provider at all. classRouter is
    // dark by default (retrieval.schema.ts), so it must be turned on for that short-circuit to run.
    config.retrieval.classRouter = true;

    const runtime = await buildServerRuntime(config, join(vaultDir, "config.json"));
    try {
      const db: Database = openMemoryDb();
      provisionCacheDb(db);
      const ctx = {
        caller: "test",
        authenticated: true,
        grantedScopes: new Set(["*"]),
        vaultId: "main",
        db,
      };

      const res = un<ReflectData>(
        await runtime.registry.dispatch(
          "reflect",
          { vault: "main", query: '"unbound roles regression probe"' },
          ctx as never,
        ),
      );

      // Not vacuous: `available: false` with a "inference gateway not configured" message is a
      // DIFFERENT, equally valid shape this same tool returns when `roles` is null
      // (tools/m7/knowledge/reflect.ts) — asserting `available` alone without also pinning the
      // live-gateway answer would pass whether or not `roles` actually reached wireDomainTools.
      expect(res.available).toBe(true);
      expect(res.answer).toBe("the stubbed answer");
    } finally {
      await runtime.close("test cleanup");
    }
    // THE-856: this asserts a wiring invariant (reflect stays available when plane.enabled=false),
    // not a latency budget — the default 5s flakes only on windows-latest, where the ~24s
    // perf-isolate test immediately preceding it leaves the runner saturated. A generous 15s
    // absorbs that contention without weakening the assertion.
  }, 15000);
});
