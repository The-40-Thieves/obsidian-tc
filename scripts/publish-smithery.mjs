#!/usr/bin/env node
// publish-smithery (THE-956, rewritten THE-966) — every other directory listing updates itself on
// a version tag (the MCP Registry via `publish-registry`, the un-prefixed plugin release via
// mirror-plugin-release.mjs); Smithery was the one surface still needing a human hand, and even
// after THE-956 wired it up, the listing showed "No capabilities found" and was absent from
// Smithery search.
//
// HISTORY. THE-956 shelled out to `smithery mcp publish <bundle>.mcpb -n <name>` (CLI 4.11.1).
// That CLI forwards only the MCPB manifest's `tools` array into the release, and MCPB manifests
// cannot carry a tool's `inputSchema` (`mcpb validate` rejects the key) while the Smithery registry
// requires one per tool to build a server card — upstream smithery-cli#787, open since July 2026,
// unfixed as of 2026-09-06 (CLI 4.11.1 latest). Our manifest declares no `tools` at all, so every
// publish through the CLI succeeded with an empty card. The CLI path is now history: this script
// talks to the registry API directly instead, sending a `serverCard` with real, schema-bearing
// tools (see scripts/../packages/server/scripts/gen-smithery-server-card.ts, which generates that
// card from the server's own tool/prompt/resource definitions — never hand-copied).
//
// API CONTRACT (read from `@smithery/api` 0.68.0's generated client, since the public docs page
// under-specifies the exact paths/fields — `resources/servers/releases.d.ts` and `.js`):
//   PUT  https://api.smithery.ai/servers/{qualifiedName}/releases   multipart: payload, bundle
//   GET  https://api.smithery.ai/servers/{qualifiedName}/releases/{id}   (poll for status + logs)
// `payload` is `JSON.stringify({ type: "stdio", runtime, configSchema?, serverCard })` — the same
// shape `arcadeai-labs/smithery-cli`'s own `getBundleDeployPayload` (src/lib/mcpb.ts) builds from a
// bundle's manifest.json, so this script's payload is a SUPERSET of the CLI's, not a different
// shape: `runtime` from `detectRuntime` below mirrors `detectBundleRuntime`'s `manifest.server.type
// === "node"` branch (our mcpb/manifest.json always declares "node" — the archive `bin/` fallback
// the CLI also checks for a `"binary"` server type is not reproduced here since it would require
// unzipping the bundle just to read a field this repo's manifest never varies); `configSchema` from
// `buildConfigSchema` below mirrors `convertMCPBUserConfigToJSONSchema`, over the SAME
// mcpb/manifest.json `user_config` block the CLI reads (not the packed bundle's copy — reading the
// checked-in manifest directly means this script never needs to unzip the .mcpb file at all).
// Auth is `Authorization: Bearer $SMITHERY_API_KEY` (client.js's `buildHeaders`).
//
// No new dependency: Node 24's built-in `fetch`/`FormData`/`Blob` do the multipart upload — the
// same reason THE-956's execFileSync runner needed no dependency either.
//
// Never logs a secret: SMITHERY_API_KEY is read only to check it's non-empty and to build the
// Authorization header actually sent — it is never interpolated into a string this script builds
// or included in argv. It COULD still reach stdout/stderr indirectly, though: a failed deploy's
// response body, a poll log line, or a release's error log all come from Smithery itself, and
// nothing stops a 4xx handler from echoing the request's own Authorization header back in its
// error text. `redact()` below is applied to every such server-derived string before it is logged
// or put in an Error, so even that reflection case can't leak the key.
//
// Every network call also carries `signal: AbortSignal.timeout(...)`, bounded by the operation's
// remaining `pollTimeoutMs` budget and capped per-request at `DEFAULT_REQUEST_TIMEOUT_MS` — a
// trickling or hung response otherwise held the job open indefinitely, since the poll loop's own
// deadline check only ran BETWEEN requests, never around one already in flight.
//
// Prereleases (a version containing "-", e.g. 1.28.0-rc.1) are skipped outright: the live
// Smithery listing (`mcpUrl`) is what users actually hit, so an RC must never be deployed there.
// This is a TRUE no-op, checked before even the SMITHERY_API_KEY presence check — mirrored by the
// same prerelease gate at the workflow-step level (publish.yml), so the guard holds even if a
// caller invokes this script directly.
//
// Dry-run reads the local bundle/manifest/server-card (to prove the payload actually builds) but
// makes no network call at all — it prints the request it would send and returns.
//
// No idempotency preflight, unlike this repo's other publish jobs (publish-npm's F3,
// publish-registry's exact-match GET): probed live 2026-09-05 against the already-published
// 1.27.0 bundle (task-5-report.md, THE-956) and a REPEAT publish of an already-listed version is
// not an error — Smithery accepts it as a new release (`status: SUCCESS`, a fresh `deploymentId`)
// and redeploys the hosted `mcpUrl`. So a re-run of this job is safe by construction; there is no
// "duplicate/already published" response for this script to special-case, because none exists.
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The org's Smithery namespace, confirmed 2026-09-05 against the live registry — the 1.27.0
// listing already published under it by hand (see
// docs/superpowers/plans/2026-09-03-listings/smithery.md). A constant, not derived from
// server.json/package.json: Smithery's qualified name is an org-controlled slug on Smithery's own
// side, unrelated to this repo's own package/server names.
export const SMITHERY_NAME = "the-40-thieves/obsidian-tc";

export const SMITHERY_API_BASE = "https://api.smithery.ai";

// The default MCPB manifest this script reads `server.type` and `user_config` from — the checked-
// in source, not the packed bundle's copy, so no unzip step is needed (see the module header).
const DEFAULT_MANIFEST_PATH = join(ROOT, "mcpb", "manifest.json");

// A release the CLI itself reported immediately as SUCCESS never needed polling (deploy.ts's own
// `if (payload.type === "stdio" && result.status === "SUCCESS")` fast path) — these are the other
// statuses a release can end on, all of which mean "stop polling, this failed"
// (`@smithery/api`'s `ReleaseGetResponse.status` doc comment lists the full enum).
const TERMINAL_FAILURE_STATUSES = new Set([
  "FAILURE",
  "FAILURE_SCAN",
  "AUTH_REQUIRED",
  "AUTH_TIMEOUT",
  "INTERNAL_ERROR",
  "CANCELLED",
]);

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60 * 1_000;

// Per-request abort ceiling: no single fetch — the PUT, or any poll GET — may block longer than
// this, regardless of how much of the overall `pollTimeoutMs` budget remains. A generous 60s: long
// enough that a normal request never trips it, short enough that a stalled/trickling response can't
// hold a CI job open for the full 5-minute poll budget, let alone indefinitely.
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** `fetch` wrapper — the injection point tests replace with a fake (no network, no real key). */
export function defaultFetch(url, init) {
  return fetch(url, init);
}

/** Injectable so tests never wait on a real timer. */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Injectable so a test can abort deterministically (no real timer, no CI-timing flakiness) instead
 * of waiting out a real `AbortSignal.timeout` — the same reason `sleep`/`now` are injected rather
 * than hardcoded. Production code always gets the real thing.
 */
function defaultCreateTimeoutSignal(ms) {
  return AbortSignal.timeout(ms);
}

/**
 * The per-request abort budget: whatever is left until `deadline`, floored at 1ms (never zero or
 * negative — `AbortSignal.timeout` requires a positive duration) and capped at
 * `DEFAULT_REQUEST_TIMEOUT_MS` so one request can never claim the whole remaining budget for
 * itself.
 */
function requestTimeoutMs(deadline, now) {
  return Math.max(1, Math.min(deadline - now(), DEFAULT_REQUEST_TIMEOUT_MS));
}

/** True for the error `fetch` rejects with when its `AbortSignal` fires (abort or timeout). */
function isAbortOrTimeout(err) {
  return err?.name === "AbortError" || err?.name === "TimeoutError";
}

/**
 * Replaces every occurrence of the real `SMITHERY_API_KEY` with `[redacted]`. Applied to every
 * string built from a server RESPONSE (a failed request's body, a poll log line, a release's error
 * log) before it is logged or put in an Error — see the module header for why a response, not just
 * this script's own output, needs this. A no-op when the key is unset/empty (dry-run, or a test
 * with no key), and safe on non-string input (returned unchanged).
 */
export function redact(text) {
  const key = process.env.SMITHERY_API_KEY;
  if (!key || typeof text !== "string") return text;
  return text.split(key).join("[redacted]");
}

export function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--bundle") args.bundle = argv[++i];
    else if (a === "--version") args.version = argv[++i];
    else if (a === "--server-card") args.serverCard = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else throw new Error(`publish-smithery: unrecognized argument: ${a}`);
  }
  for (const [key, flag] of Object.entries({
    bundle: "--bundle",
    version: "--version",
    serverCard: "--server-card",
  })) {
    if (!args[key]) throw new Error(`publish-smithery: ${flag} is required`);
  }
  return args;
}

/** A prerelease version (e.g. "1.28.0-rc.1") contains a "-" per semver; a stable one never does. */
export function isPrerelease(version) {
  return version.includes("-");
}

/**
 * Mirrors `arcadeai-labs/smithery-cli`'s `detectBundleRuntime` (src/lib/mcpb.ts), minus the
 * archive `bin/` fallback for an implicit `"binary"` server type: that branch exists only for a
 * bundle whose manifest omits `server.type` altogether, and this repo's mcpb/manifest.json always
 * declares one ("node", checked at `bundle-mcpb.ts`'s validate step) — so reproducing it here would
 * add an unzip step for a case that cannot occur against this repo's own manifest.
 */
export function detectRuntime(manifest) {
  const command = basename(manifest.server?.mcp_config?.command ?? "");
  if (command === "bun") return "bun";
  if (manifest.server?.type === "python") return "python";
  if (manifest.server?.type === "node") return "node";
  if (manifest.server?.type === "binary") return "binary";
  throw new Error(
    `publish-smithery: could not determine bundle runtime from manifest.server.type: ${JSON.stringify(manifest.server?.type)}`,
  );
}

/**
 * Mirrors `arcadeai-labs/smithery-cli`'s `convertMCPBUserConfigToJSONSchema` (src/lib/mcpb.ts):
 * flat dot-path MCPB `user_config` keys (`"auth.apiKey": {...}`) become a nested JSON Schema
 * (`{auth: {apiKey: {...}}}`); a top-level key with no dot stays top-level. Returns `undefined`
 * for an empty/missing `user_config` (no `configSchema` key at all, matching the CLI's own
 * `configSchema ? {configSchema} : {}` spread) rather than an empty schema object.
 */
export function buildConfigSchema(userConfig) {
  if (!userConfig || Object.keys(userConfig).length === 0) return undefined;
  const schema = { type: "object", properties: {} };
  const topLevelRequired = [];
  for (const [dotKey, option] of Object.entries(userConfig)) {
    const parts = dotKey.split(".");
    let current = schema;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      current.properties[part] ??= { type: "object", properties: {} };
      current = current.properties[part];
    }
    const leafKey = parts[parts.length - 1];
    const propertyType =
      option.type === "directory" || option.type === "file" ? "string" : option.type;
    current.properties[leafKey] = {
      type: option.multiple ? "array" : propertyType,
      ...(option.multiple ? { items: { type: propertyType } } : {}),
      ...(option.title ? { title: option.title } : {}),
      ...(option.description ? { description: option.description } : {}),
      ...(option.default !== undefined ? { default: option.default } : {}),
    };
    if (option.required) {
      if (parts.length === 1) topLevelRequired.push(leafKey);
      else {
        const parentKey = parts[0];
        schema.required ??= [];
        if (!schema.required.includes(parentKey)) schema.required.push(parentKey);
        let parent = schema.properties[parentKey];
        for (let i = 1; i < parts.length - 1; i++) parent = parent.properties[parts[i]];
        parent.required ??= [];
        if (!parent.required.includes(leafKey)) parent.required.push(leafKey);
      }
    }
  }
  if (topLevelRequired.length > 0) schema.required = topLevelRequired;
  return schema;
}

/** Builds the API deploy payload (the JSON string that becomes the `payload` multipart field). */
export function buildPayload(manifest, serverCard) {
  const configSchema = buildConfigSchema(manifest.user_config);
  return {
    type: "stdio",
    runtime: detectRuntime(manifest),
    ...(configSchema ? { configSchema } : {}),
    serverCard,
  };
}

/**
 * Classifies one release response — the deploy call's own immediate result, or a later poll —
 * pure and injectable so it's testable with no network. Returns `{ ok, message }` when the status
 * is terminal (SUCCESS or a failure status); returns `null` when the status is still in progress
 * and the caller should keep polling.
 */
export function classifyReleaseStatus({ name, deploymentId, status, mcpUrl, logs, version }) {
  if (status === "SUCCESS") {
    return {
      ok: true,
      message: redact(
        `published ${name} — deployment ${deploymentId} (${mcpUrl}) (release ${version}).`,
      ),
    };
  }
  if (TERMINAL_FAILURE_STATUSES.has(status)) {
    const errorLog = logs?.find((l) => l.level === "failure" || l.error?.message);
    const detail = errorLog ? `: ${errorLog.error?.message ?? errorLog.message}` : "";
    return {
      ok: false,
      message: redact(`release ${deploymentId} ended with status "${status}"${detail}`),
    };
  }
  return null;
}

/**
 * GET the release's current status + logs, aborting after `timeoutMs` so a stalled response can't
 * hold the poll loop open past its own deadline (see `requestTimeoutMs`, the caller's budget).
 */
async function getRelease(fetchImpl, name, id, timeoutMs, createTimeoutSignal) {
  const path = `/servers/${name}/releases/${id}`;
  let res;
  try {
    res = await fetchImpl(
      `${SMITHERY_API_BASE}/servers/${encodeURIComponent(name)}/releases/${encodeURIComponent(id)}`,
      {
        headers: { Authorization: `Bearer ${process.env.SMITHERY_API_KEY}` },
        signal: createTimeoutSignal(timeoutMs),
      },
    );
  } catch (err) {
    if (isAbortOrTimeout(err)) {
      throw new Error(`publish-smithery: request to ${path} timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
  if (!res.ok) {
    throw new Error(
      redact(`publish-smithery: status poll failed: ${res.status} ${res.statusText}`),
    );
  }
  return res.json();
}

/**
 * Polls a release until it reaches a terminal status, printing each new log line as it appears.
 * Throws on a failure status or on exceeding `pollTimeoutMs` — both are treated as a failed job,
 * same as the immediate-response path in `publishToSmithery`.
 */
export async function pollUntilTerminal(
  fetchImpl,
  name,
  deploymentId,
  version,
  {
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
    sleep = defaultSleep,
    now = Date.now,
    createTimeoutSignal = defaultCreateTimeoutSignal,
    // Shares one overall deadline with the deploy PUT that preceded this poll
    // (`publishToSmithery` passes its own already-computed deadline through here) rather than
    // starting a fresh `pollTimeoutMs` clock at the first poll — a caller that exercises
    // `pollUntilTerminal` directly (as this file's own tests do) gets one computed from
    // `pollTimeoutMs` instead.
    deadline = now() + pollTimeoutMs,
  } = {},
) {
  let loggedCount = 0;
  while (true) {
    const release = await getRelease(
      fetchImpl,
      name,
      deploymentId,
      requestTimeoutMs(deadline, now),
      createTimeoutSignal,
    );
    for (const line of (release.logs ?? []).slice(loggedCount)) {
      console.log(
        `publish-smithery: [${redact(String(line.stage))}] ${redact(String(line.message))}`,
      );
    }
    loggedCount = release.logs?.length ?? loggedCount;
    const result = classifyReleaseStatus({
      name,
      deploymentId,
      status: release.status,
      mcpUrl: release.mcpUrl,
      logs: release.logs,
      version,
    });
    if (result) {
      if (!result.ok) throw new Error(`publish-smithery: ${result.message}`);
      return result;
    }
    if (now() >= deadline) {
      throw new Error(
        `publish-smithery: release ${deploymentId} did not reach a terminal status within ${pollTimeoutMs}ms (last status "${release.status}")`,
      );
    }
    await sleep(pollIntervalMs);
  }
}

/**
 * Orchestrates the publish. `fetchImpl` is injected (defaults to `defaultFetch`) so every branch
 * is testable without real network access or a real key.
 */
export async function publishToSmithery({
  bundle,
  version,
  serverCard: serverCardPath,
  dryRun = false,
  fetchImpl = defaultFetch,
  name = SMITHERY_NAME,
  manifestPath = DEFAULT_MANIFEST_PATH,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  sleep = defaultSleep,
  now = Date.now,
  createTimeoutSignal = defaultCreateTimeoutSignal,
}) {
  if (isPrerelease(version)) {
    console.log(
      `publish-smithery: ${version} is a prerelease (contains "-") — Smithery publish is ` +
        "reserved for stable releases only. Skipping; nothing read or written.",
    );
    return { action: "skipped-prerelease" };
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const serverCard = JSON.parse(readFileSync(serverCardPath, "utf8"));
  const payload = buildPayload(manifest, serverCard);

  if (dryRun) {
    // Proves the artifact this run would actually upload exists — a real publish only discovers a
    // missing bundle when `readFileSync(bundle)` below runs, which a dry run never reaches. Without
    // this, `--dry-run` against a typo'd/nonexistent `--bundle` path printed "would PUT" and exited
    // 0, telling a caller nothing was wrong.
    statSync(bundle);
    console.log(
      `publish-smithery: [dry-run] would PUT ${SMITHERY_API_BASE}/servers/${name}/releases — ` +
        `runtime ${payload.runtime}, ${serverCard.tools?.length ?? 0} tools, bundle ${bundle} (release ${version})`,
    );
    return { action: "dry-run" };
  }

  if (!process.env.SMITHERY_API_KEY) {
    throw new Error(
      "SMITHERY_API_KEY is empty — set the repo secret before this job can publish (this repo " +
        "owns the Smithery listing; a silent skip would hide a broken release).",
    );
  }

  // One overall deadline for the whole publish attempt (the PUT, plus every poll GET after it) —
  // pollUntilTerminal below reuses this exact value rather than starting a fresh pollTimeoutMs
  // clock once the PUT returns, so a slow PUT eats into the same budget a slow poll would.
  const deadline = now() + pollTimeoutMs;

  const form = new FormData();
  form.set("payload", JSON.stringify(payload));
  form.set("bundle", new Blob([readFileSync(bundle)]), basename(bundle));

  const deployPath = `/servers/${name}/releases`;
  const putTimeoutMs = requestTimeoutMs(deadline, now);
  let deployRes;
  try {
    deployRes = await fetchImpl(
      `${SMITHERY_API_BASE}/servers/${encodeURIComponent(name)}/releases`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${process.env.SMITHERY_API_KEY}` },
        body: form,
        signal: createTimeoutSignal(putTimeoutMs),
      },
    );
  } catch (err) {
    if (isAbortOrTimeout(err)) {
      throw new Error(
        `publish-smithery: request to ${deployPath} timed out after ${putTimeoutMs}ms`,
      );
    }
    throw err;
  }
  if (!deployRes.ok) {
    const body = await deployRes.text().catch(() => "");
    throw new Error(
      redact(
        `publish-smithery: deploy request failed: ${deployRes.status} ${deployRes.statusText}${body ? ` — ${body}` : ""}`,
      ),
    );
  }
  const deployed = await deployRes.json();
  // Every field of a server response is server-controlled, the id included — redact it too.
  console.log(
    `publish-smithery: release ${redact(String(deployed.deploymentId))} accepted, polling status...`,
  );

  const immediate = classifyReleaseStatus({
    name,
    deploymentId: deployed.deploymentId,
    status: deployed.status,
    mcpUrl: deployed.mcpUrl,
    version,
  });
  let result = immediate;
  if (!result) {
    result = await pollUntilTerminal(fetchImpl, name, deployed.deploymentId, version, {
      pollIntervalMs,
      pollTimeoutMs,
      sleep,
      now,
      createTimeoutSignal,
      deadline,
    });
  } else if (!result.ok) {
    throw new Error(`publish-smithery: ${result.message}`);
  }

  console.log(`publish-smithery: ${result.message}`);
  return { action: "published", deploymentId: deployed.deploymentId, mcpUrl: deployed.mcpUrl };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  return publishToSmithery(args);
}

// Importing this module (as its test file does) must have no side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (err) {
    // Defense in depth: every throw site above already redacts its own message, but this is the
    // last point before anything reaches stdout/stderr, so it redacts too rather than trusting
    // that no future call site (or an error thrown by something other than this script) forgets to.
    console.error(`publish-smithery: FAIL — ${redact(err.message)}`);
    process.exit(1);
  }
}
