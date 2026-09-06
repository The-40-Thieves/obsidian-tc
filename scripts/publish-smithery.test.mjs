// Tests for scripts/publish-smithery.mjs (THE-956, rewritten THE-966).
//
// The registry call goes through an injected `fetchImpl` — no subprocess, no real network, no real
// key. `detectRuntime`/`buildConfigSchema`/`buildPayload`/`classifyReleaseStatus` are pure and
// tested directly; `pollUntilTerminal` and `publishToSmithery` are tested with a fake `fetchImpl`,
// a fake `sleep` (resolves instantly, no real timers), and a fake `now` (a virtual clock) so the
// timeout branch is deterministic without waiting 5 real minutes.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, before, test } from "node:test";
import {
  buildConfigSchema,
  buildPayload,
  classifyReleaseStatus,
  detectRuntime,
  isPrerelease,
  parseArgs,
  pollUntilTerminal,
  publishToSmithery,
  redact,
  SMITHERY_API_BASE,
  SMITHERY_NAME,
} from "./publish-smithery.mjs";

const VERSION = "1.28.3";

// ---- fixtures ---------------------------------------------------------------------------------

let dir;
let bundlePath;
let manifestPath;
let serverCardPath;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "publish-smithery-test-"));
  bundlePath = join(dir, "obsidian-tc.mcpb");
  writeFileSync(bundlePath, "fake mcpb bytes, not a real zip");

  manifestPath = join(dir, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      server: { type: "node", mcp_config: { command: "node" } },
      user_config: {
        config_path: { type: "file", title: "Config file", description: "Path.", required: true },
        default_vault: { type: "string", title: "Default vault id", description: "Id." },
      },
    }),
  );

  serverCardPath = join(dir, "smithery-server-card.json");
  writeFileSync(
    serverCardPath,
    JSON.stringify({
      serverInfo: { name: "obsidian-tc", version: VERSION },
      tools: [
        {
          name: "find_capability",
          inputSchema: { type: "object", properties: { query: { type: "string" } } },
        },
      ],
      prompts: [{ name: "summarize_note", arguments: [] }],
      resources: [{ uri: "obsidian-tc://catalog", name: "Tool catalog" }],
    }),
  );
});

afterEach(() => {
  delete process.env.SMITHERY_API_KEY;
});

// node:test has no global after-suite hook here without importing `after`; the OS reclaims tmpdir
// entries anyway, but clean up explicitly for a tidy local run.
process.on("exit", () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

const REAL_SUCCESS_DEPLOY = {
  deploymentId: "d1",
  status: "SUCCESS",
  mcpUrl: "https://x.run.tools",
};

/** Captures every console.log/console.error line during `fn`, restoring both afterward even if
 *  `fn` throws — used by the redaction tests, which must inspect output from a call that rejects. */
async function withCapturedConsole(fn) {
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...parts) => lines.push(parts.join(" "));
  console.error = (...parts) => lines.push(parts.join(" "));
  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return lines;
}

// ---- pure helpers -------------------------------------------------------------------------------

test("isPrerelease: a version with a hyphen is a prerelease", () => {
  assert.equal(isPrerelease("1.28.0-rc.1"), true);
});

test("isPrerelease: a plain semver is not a prerelease", () => {
  assert.equal(isPrerelease(VERSION), false);
});

test("parseArgs: requires --bundle, --version, and --server-card", () => {
  assert.throws(() => parseArgs([]), /--bundle is required/);
  assert.throws(() => parseArgs(["--bundle", "b"]), /--version is required/);
  assert.throws(
    () => parseArgs(["--bundle", "b", "--version", VERSION]),
    /--server-card is required/,
  );
});

test("parseArgs: --dry-run is optional and defaults to false", () => {
  const args = parseArgs(["--bundle", "b", "--version", VERSION, "--server-card", "c"]);
  assert.equal(args.dryRun, false);
});

test("parseArgs: rejects an unrecognized flag", () => {
  assert.throws(() => parseArgs(["--nope"]), /unrecognized argument: --nope/);
});

test("detectRuntime: manifest.server.type 'node' -> 'node'", () => {
  assert.equal(detectRuntime({ server: { type: "node" } }), "node");
});

test("detectRuntime: a 'bun' command wins over server.type", () => {
  assert.equal(
    detectRuntime({ server: { type: "node", mcp_config: { command: "/usr/bin/bun" } } }),
    "bun",
  );
});

test("detectRuntime: manifest.server.type 'python' -> 'python'", () => {
  assert.equal(detectRuntime({ server: { type: "python" } }), "python");
});

test("detectRuntime: manifest.server.type 'binary' -> 'binary'", () => {
  assert.equal(detectRuntime({ server: { type: "binary" } }), "binary");
});

test("detectRuntime: an unrecognized server.type throws", () => {
  assert.throws(
    () => detectRuntime({ server: { type: "wasm" } }),
    /could not determine bundle runtime/,
  );
});

test("buildConfigSchema: no user_config -> undefined (no configSchema key at all)", () => {
  assert.equal(buildConfigSchema(undefined), undefined);
  assert.equal(buildConfigSchema({}), undefined);
});

test("buildConfigSchema: flat keys, one required — matches this repo's real manifest shape", () => {
  const schema = buildConfigSchema({
    config_path: { type: "file", title: "Config file", description: "Path.", required: true },
    default_vault: { type: "string", title: "Default vault id" },
  });
  assert.deepEqual(schema, {
    type: "object",
    properties: {
      config_path: { type: "string", title: "Config file", description: "Path." },
      default_vault: { type: "string", title: "Default vault id" },
    },
    required: ["config_path"],
  });
});

test("buildConfigSchema: a dotted key nests, and marks the parent required too", () => {
  const schema = buildConfigSchema({
    "auth.apiKey": { type: "string", required: true },
  });
  assert.deepEqual(schema, {
    type: "object",
    properties: {
      auth: {
        type: "object",
        properties: { apiKey: { type: "string" } },
        required: ["apiKey"],
      },
    },
    required: ["auth"],
  });
});

test("buildConfigSchema: multiple:true becomes an array of the base type", () => {
  const schema = buildConfigSchema({ tags: { type: "string", multiple: true } });
  assert.deepEqual(schema.properties.tags, { type: "array", items: { type: "string" } });
});

test("buildPayload: stdio/runtime/configSchema/serverCard shape", () => {
  const manifest = {
    server: { type: "node" },
    user_config: { config_path: { type: "file", required: true } },
  };
  const serverCard = { serverInfo: { name: "obsidian-tc", version: VERSION }, tools: [] };
  const payload = buildPayload(manifest, serverCard);
  assert.equal(payload.type, "stdio");
  assert.equal(payload.runtime, "node");
  assert.deepEqual(payload.configSchema, {
    type: "object",
    properties: { config_path: { type: "string" } },
    required: ["config_path"],
  });
  assert.equal(payload.serverCard, serverCard);
});

test("buildPayload: no user_config -> payload carries no configSchema key", () => {
  const payload = buildPayload({ server: { type: "node" } }, { serverInfo: {} });
  assert.equal("configSchema" in payload, false);
});

test("classifyReleaseStatus: SUCCESS is ok and names the deployment + mcpUrl", () => {
  const result = classifyReleaseStatus({
    name: SMITHERY_NAME,
    deploymentId: "d1",
    status: "SUCCESS",
    mcpUrl: "https://x",
    version: VERSION,
  });
  assert.equal(result.ok, true);
  assert.match(result.message, /published the-40-thieves\/obsidian-tc — deployment d1/);
});

test("classifyReleaseStatus: a terminal failure status fails, quoting the error log", () => {
  const result = classifyReleaseStatus({
    name: SMITHERY_NAME,
    deploymentId: "d1",
    status: "FAILURE",
    logs: [
      { stage: "scan", level: "failure", message: "bad thing", error: { message: "bad thing" } },
    ],
    version: VERSION,
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /status "FAILURE".*bad thing/);
});

test("classifyReleaseStatus: AUTH_REQUIRED is treated as a terminal failure (stdio never needs OAuth)", () => {
  const result = classifyReleaseStatus({
    name: SMITHERY_NAME,
    deploymentId: "d1",
    status: "AUTH_REQUIRED",
  });
  assert.equal(result.ok, false);
});

test("classifyReleaseStatus: an in-progress status (e.g. WORKING) returns null — keep polling", () => {
  assert.equal(
    classifyReleaseStatus({ name: SMITHERY_NAME, deploymentId: "d1", status: "WORKING" }),
    null,
  );
});

test("redact: replaces every occurrence of the real key with [redacted]", () => {
  process.env.SMITHERY_API_KEY = "sk-abc123";
  assert.equal(
    redact("Authorization: Bearer sk-abc123 rejected (key sk-abc123 unknown)"),
    "Authorization: Bearer [redacted] rejected (key [redacted] unknown)",
  );
});

test("redact: a no-op when the key is unset (dry-run, or no key configured)", () => {
  delete process.env.SMITHERY_API_KEY;
  assert.equal(redact("nothing to redact here"), "nothing to redact here");
});

test("redact: passes non-string input through unchanged", () => {
  process.env.SMITHERY_API_KEY = "sk-abc123";
  assert.equal(redact(undefined), undefined);
});

// ---- pollUntilTerminal --------------------------------------------------------------------------

test("pollUntilTerminal: polls until SUCCESS, logging new lines as they appear", async () => {
  let calls = 0;
  const responses = [
    { status: "WORKING", logs: [{ stage: "deploy", message: "uploading" }] },
    {
      status: "WORKING",
      logs: [
        { stage: "deploy", message: "uploading" },
        { stage: "scan", message: "scanning" },
      ],
    },
    {
      status: "SUCCESS",
      mcpUrl: "https://x",
      logs: [
        { stage: "deploy", message: "uploading" },
        { stage: "scan", message: "scanning" },
      ],
    },
  ];
  const fetchImpl = async () => {
    const body = responses[calls++];
    return { ok: true, json: async () => body };
  };
  let sleeps = 0;
  const result = await pollUntilTerminal(fetchImpl, SMITHERY_NAME, "d1", VERSION, {
    sleep: async () => {
      sleeps++;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 3);
  assert.equal(sleeps, 2);
});

test("pollUntilTerminal: a failure status throws, naming the release", async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ status: "FAILURE", logs: [] }) });
  await assert.rejects(
    () => pollUntilTerminal(fetchImpl, SMITHERY_NAME, "d1", VERSION, { sleep: async () => {} }),
    /status "FAILURE"/,
  );
});

test("pollUntilTerminal: a non-ok status response throws", async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, statusText: "Internal Server Error" });
  await assert.rejects(
    () => pollUntilTerminal(fetchImpl, SMITHERY_NAME, "d1", VERSION, { sleep: async () => {} }),
    /status poll failed: 500/,
  );
});

test("pollUntilTerminal: exceeding the timeout throws rather than polling forever", async () => {
  let now = 0;
  const fetchImpl = async () => ({ ok: true, json: async () => ({ status: "WORKING", logs: [] }) });
  await assert.rejects(
    () =>
      pollUntilTerminal(fetchImpl, SMITHERY_NAME, "d1", VERSION, {
        pollTimeoutMs: 10,
        pollIntervalMs: 1,
        sleep: async () => {
          now += 20; // one sleep already exceeds the 10ms timeout
        },
        now: () => now,
      }),
    /did not reach a terminal status within 10ms/,
  );
});

test("pollUntilTerminal: a GET that never resolves is aborted at the per-request timeout rather than hanging forever", async () => {
  // A REAL `AbortSignal.timeout` here would make this test depend on the real clock actually
  // firing within its window — exactly the kind of timer race this repo's own history warns
  // against (a 5ms setInterval racing a 20ms deadline flaked the reranker-local lock-deadline test,
  // THE-965). `createTimeoutSignal` is injected instead: the fake below returns an
  // `AbortController`'s signal and fires `abort()` on the next microtask, so the request the
  // fix this test guards — previously no fetch call carried a signal at all, so a fetchImpl that
  // never resolves would have hung this test — is aborted deterministically, no real timer, no
  // waiting.
  const fetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  const createTimeoutSignal = () => {
    const controller = new AbortController();
    queueMicrotask(() => controller.abort());
    return controller.signal;
  };
  await assert.rejects(
    () =>
      pollUntilTerminal(fetchImpl, SMITHERY_NAME, "d1", VERSION, {
        pollTimeoutMs: 50,
        createTimeoutSignal,
      }),
    /publish-smithery: request to \/servers\/.*\/releases\/d1 timed out after \d+ms/,
  );
});

// ---- publishToSmithery orchestration -------------------------------------------------------------

function args(overrides = {}) {
  return {
    bundle: bundlePath,
    version: VERSION,
    serverCard: serverCardPath,
    manifestPath,
    ...overrides,
  };
}

test("prerelease: skips entirely, before any file read or fetch call", async () => {
  delete process.env.SMITHERY_API_KEY;
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, json: async () => REAL_SUCCESS_DEPLOY };
  };
  const result = await publishToSmithery(
    args({
      version: "1.28.0-rc.1",
      bundle: "/nonexistent",
      serverCard: "/nonexistent",
      manifestPath: "/nonexistent",
      fetchImpl,
    }),
  );
  assert.equal(result.action, "skipped-prerelease");
  assert.equal(calls, 0);
});

test("missing key: fails with a message naming SMITHERY_API_KEY, before any fetch call", async () => {
  delete process.env.SMITHERY_API_KEY;
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, json: async () => REAL_SUCCESS_DEPLOY };
  };
  await assert.rejects(() => publishToSmithery(args({ fetchImpl })), /SMITHERY_API_KEY is empty/);
  assert.equal(calls, 0);
});

test("dry-run: builds the payload from real local files and never calls fetch (no key needed)", async () => {
  delete process.env.SMITHERY_API_KEY;
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, json: async () => REAL_SUCCESS_DEPLOY };
  };
  const result = await publishToSmithery(args({ dryRun: true, fetchImpl }));
  assert.equal(result.action, "dry-run");
  assert.equal(calls, 0);
});

test("dry-run: a nonexistent --bundle path fails the dry run instead of printing 'would PUT'", async () => {
  delete process.env.SMITHERY_API_KEY;
  const missingBundle = join(dir, "does-not-exist.mcpb");
  await assert.rejects(
    () => publishToSmithery(args({ dryRun: true, bundle: missingBundle })),
    new RegExp(missingBundle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});

test("SUCCESS: an immediate SUCCESS deploy response publishes with no polling", async () => {
  process.env.SMITHERY_API_KEY = "test-key-not-real";
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls++;
    assert.equal(init.method, "PUT");
    assert.match(
      url,
      /^https:\/\/api\.smithery\.ai\/servers\/the-40-thieves%2Fobsidian-tc\/releases$/,
    );
    return { ok: true, json: async () => REAL_SUCCESS_DEPLOY };
  };
  const result = await publishToSmithery(args({ fetchImpl }));
  assert.equal(result.action, "published");
  assert.equal(calls, 1); // no poll needed
});

test("WORKING then SUCCESS: an in-progress deploy response is polled to completion", async () => {
  process.env.SMITHERY_API_KEY = "test-key-not-real";
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls++;
    if (init?.method === "PUT")
      return { ok: true, json: async () => ({ deploymentId: "d1", status: "WORKING" }) };
    return { ok: true, json: async () => ({ status: "SUCCESS", mcpUrl: "https://x", logs: [] }) };
  };
  const result = await publishToSmithery(args({ fetchImpl, sleep: async () => {} }));
  assert.equal(result.action, "published");
  assert.equal(calls, 2);
});

test("a non-ok deploy response fails the job with the status text", async () => {
  process.env.SMITHERY_API_KEY = "test-key-not-real";
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    statusText: "Unauthorized",
    text: async () => "bad key",
  });
  await assert.rejects(
    () => publishToSmithery(args({ fetchImpl })),
    /deploy request failed: 401.*bad key/,
  );
});

test("an immediate FAILURE status fails the job", async () => {
  process.env.SMITHERY_API_KEY = "test-key-not-real";
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ deploymentId: "d1", status: "FAILURE" }),
  });
  await assert.rejects(() => publishToSmithery(args({ fetchImpl })), /status "FAILURE"/);
});

test("polling that never reaches a terminal status within the timeout fails the job", async () => {
  process.env.SMITHERY_API_KEY = "test-key-not-real";
  let now = 0;
  const fetchImpl = async (_url, init) => {
    if (init?.method === "PUT")
      return { ok: true, json: async () => ({ deploymentId: "d1", status: "WORKING" }) };
    return { ok: true, json: async () => ({ status: "WORKING", logs: [] }) };
  };
  await assert.rejects(
    () =>
      publishToSmithery(
        args({
          fetchImpl,
          pollTimeoutMs: 10,
          pollIntervalMs: 1,
          sleep: async () => {
            now += 20;
          },
          now: () => now,
        }),
      ),
    /did not reach a terminal status/,
  );
});

test("multipart: sends 'payload' (JSON with type/runtime/serverCard, tools carrying inputSchema) and 'bundle'", async () => {
  process.env.SMITHERY_API_KEY = "test-key-not-real";
  let capturedForm;
  const fetchImpl = async (_url, init) => {
    capturedForm = init.body;
    return { ok: true, json: async () => REAL_SUCCESS_DEPLOY };
  };
  await publishToSmithery(args({ fetchImpl }));
  assert.ok(capturedForm instanceof FormData);
  const payload = JSON.parse(capturedForm.get("payload"));
  assert.equal(payload.type, "stdio");
  assert.equal(payload.runtime, "node");
  assert.ok(payload.serverCard);
  assert.equal(payload.serverCard.tools[0].name, "find_capability");
  assert.ok(payload.serverCard.tools[0].inputSchema);
  assert.equal(payload.serverCard.tools[0].inputSchema.type, "object");
  const bundleField = capturedForm.get("bundle");
  assert.ok(bundleField instanceof Blob);
});

test("the fake fetch never receives the key anywhere but the Authorization header, and no log line carries it", async () => {
  const SECRET = "super-secret-value-xyz";
  process.env.SMITHERY_API_KEY = SECRET;
  const fetchImpl = async (url, init) => {
    assert.ok(!url.includes(SECRET));
    assert.equal(init.headers.Authorization, `Bearer ${SECRET}`);
    return { ok: true, json: async () => REAL_SUCCESS_DEPLOY };
  };
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...parts) => lines.push(parts.join(" "));
  console.error = (...parts) => lines.push(parts.join(" "));
  try {
    await publishToSmithery(args({ fetchImpl }));
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.ok(!lines.some((l) => l.includes(SECRET)));
});

test("redaction: a failing deploy response body that echoes the key is redacted in the thrown message", async () => {
  const SECRET = "super-secret-value-xyz";
  process.env.SMITHERY_API_KEY = SECRET;
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    statusText: "Bad Request",
    text: async () => `invalid Authorization: Bearer ${SECRET}`,
  });
  let caught;
  const lines = await withCapturedConsole(async () => {
    try {
      await publishToSmithery(args({ fetchImpl }));
    } catch (err) {
      caught = err;
    }
  });
  assert.ok(caught, "publishToSmithery should have rejected");
  assert.ok(!caught.message.includes(SECRET), "thrown message must not carry the real key");
  assert.match(caught.message, /\[redacted\]/);
  assert.ok(!lines.some((l) => l.includes(SECRET)), "no console line may carry the real key");
});

test("redaction: poll log lines and a failure log that echo the key are redacted in console output and the thrown message", async () => {
  const SECRET = "super-secret-value-xyz";
  process.env.SMITHERY_API_KEY = SECRET;
  let call = 0;
  const fetchImpl = async (_url, init) => {
    call++;
    if (init?.method === "PUT") {
      return { ok: true, json: async () => ({ deploymentId: `d1-${SECRET}`, status: "WORKING" }) };
    }
    if (call === 2) {
      return {
        ok: true,
        json: async () => ({
          status: "WORKING",
          logs: [{ stage: `scan-${SECRET}`, message: `checking credential ${SECRET}` }],
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        status: "FAILURE",
        logs: [
          { stage: "scan", message: `checking credential ${SECRET}` },
          {
            stage: "scan",
            level: "failure",
            message: `rejected credential ${SECRET}`,
            error: { message: `rejected credential ${SECRET}` },
          },
        ],
      }),
    };
  };
  let caught;
  const lines = await withCapturedConsole(async () => {
    try {
      await publishToSmithery(args({ fetchImpl, sleep: async () => {} }));
    } catch (err) {
      caught = err;
    }
  });
  assert.ok(caught, "publishToSmithery should have rejected");
  assert.ok(!caught.message.includes(SECRET), "thrown message must not carry the real key");
  assert.match(caught.message, /\[redacted\]/);
  assert.ok(
    !lines.some((l) => l.includes(SECRET)),
    "no console line (including poll log lines) may carry the real key",
  );
  assert.ok(
    lines.some((l) => l.includes("[redacted]")),
    "the poll log line should still be printed, with the key redacted",
  );
});

test("network timeout: a PUT that never resolves is aborted at the per-request timeout rather than hanging forever", async () => {
  process.env.SMITHERY_API_KEY = "test-key-not-real";
  // Deterministic abort via injected `createTimeoutSignal` — see the pollUntilTerminal version of
  // this test above for why a real `AbortSignal.timeout` is avoided here.
  const fetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  const createTimeoutSignal = () => {
    const controller = new AbortController();
    queueMicrotask(() => controller.abort());
    return controller.signal;
  };
  await assert.rejects(
    () => publishToSmithery(args({ fetchImpl, pollTimeoutMs: 50, createTimeoutSignal })),
    /publish-smithery: request to \/servers\/.*\/releases timed out after \d+ms/,
  );
});

test("SMITHERY_API_BASE points at the real registry host", () => {
  assert.equal(SMITHERY_API_BASE, "https://api.smithery.ai");
});
