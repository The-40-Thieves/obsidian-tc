// `obsidian-tc setup` (PR A of GH #995's two-part follow-up — PR B, later, adds first-run fallback
// + MCP-client config install; NOT here). GH #995's root cause was an implicit default
// (`embeddings.provider` unset) changing meaning under an existing install when 1.31.4 shipped.
// This command is the fix's other half: detect the environment ONCE, print every decision with its
// reason, and write it into the config EXPLICITLY — never re-detect silently at boot again. All
// I/O (capability profile, the sticky-provider probe, the local-embedder/Ollama probes, the
// prompt, the write) lives HERE; cli/setup/decide.ts stays pure and injectable, and cli/setup/
// write.ts owns validation + the atomic write, so both are unit-tested without a real vault,
// Ollama, or cache db (test/setup-decide.test.ts, test/setup-write.test.ts). This file's own
// contract is proven end-to-end instead (test/setup-e2e.test.ts): run it for real against a temp
// HOME/XDG_CONFIG_HOME with a fake obsidian.json, and assert the written config loads through the
// REAL loader.
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import * as readline from "node:readline/promises";
import { ObsidianTcError, type ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { resolveCapabilityProfile } from "../../capability/profile";
import { finalizeConfig, readConfigFile } from "../../config/load";
import { DEFAULT_BUSY_TIMEOUT_MS } from "../../db/pragmas";
import { probeLocalEmbedderResolution } from "../../providers/local-embedder-registry";
import { onnxNativePrebuildStatus } from "../../providers/reranker-preflight";
import { redactConfig } from "../redact-config";
import { defaultSetupConfigPath } from "../resolve-config";
import {
  decideSetup,
  type SetupDecision,
  type SetupInputs,
  type SetupOllamaProbe,
  type SetupVaultInput,
} from "../setup/decide";
import { buildSetupConfig, writeSetupConfig } from "../setup/write";
import type { Cmd } from "../shared";
import { probeEmbeddingsProviderSource } from "./doctor-probes";

// Ollama's own documented local API (github.com/ollama/ollama/blob/main/docs/api.md, `GET
// /api/tags`, confirmed via context7 before writing this): "127.0.0.1", never "localhost" — this
// must never resolve over a network interface, only loopback, and IPv4 avoids an environment where
// "localhost" resolves to ::1 first and a v4-only Ollama listener doesn't answer on it.
const OLLAMA_TAGS_URL = "http://127.0.0.1:11434/api/tags";
// Short: this is a LOCAL loopback probe during an interactive setup command, not a network call
// depended on for correctness — a slow/hung answer must not stall the whole command for long.
const OLLAMA_PROBE_TIMEOUT_MS = 800;

async function probeOllama(): Promise<SetupOllamaProbe> {
  try {
    const res = await fetch(OLLAMA_TAGS_URL, {
      signal: AbortSignal.timeout(OLLAMA_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return { reachable: false, models: [] };
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    return {
      reachable: true,
      models: (body.models ?? [])
        .map((m) => m.name)
        .filter((n): n is string => typeof n === "string"),
    };
  } catch {
    // Not running, not listening on this port, or an unreachable network — every case degrades the
    // same way: no Ollama to consider. Never surfaced as an error; a machine with no Ollama at all
    // is the common case, not a failure.
    return { reachable: false, models: [] };
  }
}

/** True for a path that exists and is a directory — used both for `--vault` validation (finding
 *  7: a typo'd or removed vault path must never silently produce a schema-valid config) and for
 *  filtering stale registry entries. */
function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Finding 2 (HIGH, fix round 2): when a config already exists at the write target (or `--config`
 *  names one), load it through the REAL loader first — never re-derive `cacheDir`/vaults from a
 *  hard-coded `~/.obsidian-tc` guess. Returns the raw (pre-default) object whenever the file at
 *  least PARSES as JSON, and the finalized config too when it also validates. The two can now
 *  diverge: the exact pre-1.31.4 / GH #995 victim shape (vaults, no `embeddings`, no `cacheDir`)
 *  parses fine but fails `finalizeConfig` (which requires an explicit `cacheDir` once
 *  `embeddings.provider` resolves to "local" — the schema default when the block is absent, which
 *  it is here). Before this fix, ANY throw (a corrupt file OR a merely-unfinalizable one) returned
 *  `undefined` wholesale, so `buildSetupConfig` never saw `raw` and merged into an EMPTY object —
 *  discarding every key setup does not own (`auth`, `acl`, ...) the moment `--force` was passed.
 *  `raw` alone (with `config: undefined`) is undefined ONLY when the file cannot be parsed as JSON
 *  at all — a genuinely unreadable file, which really is "nothing to load". */
function loadExistingConfig(
  targetPath: string,
): { raw: Record<string, unknown>; config?: ServerConfig } | undefined {
  if (!existsSync(targetPath)) return undefined;
  let raw: Record<string, unknown>;
  try {
    raw = readConfigFile(targetPath);
  } catch {
    return undefined;
  }
  try {
    // finalizeConfig mutates its argument (applyEnvOverlays) — clone so the RAW object handed
    // back to buildSetupConfig for merging is untouched by env overlays that must never be
    // written back to disk (e.g. a JWT secret pulled from OBSIDIAN_TC_JWT_SECRET).
    const config = finalizeConfig(JSON.parse(JSON.stringify(raw)));
    return { raw, config };
  } catch (e) {
    // A deliberate, named `ObsidianTcError` (config/load.ts's own `err.invalidInput` throws — the
    // local-provider-needs-cacheDir case this command exists to repair, or a dimensions mismatch)
    // still means the file IS a real, mergeable config that merely fails one explicit rule after
    // schema validation — return `raw` so buildSetupConfig can merge into it. A raw ZodError (the
    // shape itself does not validate at all — e.g. no `vaults` array) means there is no real config
    // here to merge into; behave exactly like "no existing config" always did.
    if (e instanceof ObsidianTcError) return { raw };
    return undefined;
  }
}

/** The vaults an existing raw config file itself names — the SAME id/path filtering
 *  `buildSetupConfig` (cli/setup/write.ts) applies when merging, kept in sync with it deliberately
 *  (both only trust entries shaped `{ id: string; path: string }`). Only consulted when
 *  `loadExistingConfig` could not finalize the file (see that function's own comment) — the
 *  finalized `config.vaults` is used whenever it's available, since that has already run through
 *  full schema validation. */
function rawVaults(raw: Record<string, unknown> | undefined): SetupVaultInput[] {
  if (!raw || !Array.isArray(raw.vaults)) return [];
  return (raw.vaults as Array<{ id?: unknown; path?: unknown }>)
    .filter(
      (v): v is { id: string; path: string } =>
        typeof v?.id === "string" && typeof v?.path === "string",
    )
    .map((v) => ({ id: v.id, path: v.path }));
}

/** The cacheDir to probe an existing index against when `loadExistingConfig` could not finalize
 *  the file (see its own comment) — reads the raw `cacheDir` string directly, anchoring it to home
 *  exactly like `finalizeConfig` would have (config/load.ts's own comment on why a relative
 *  cacheDir must never be resolved against the process cwd), rather than falling all the way back
 *  to the schema-fresh default and probing the WRONG directory for a config that did name one. */
function rawCacheDirFallback(raw: Record<string, unknown> | undefined): string {
  const explicit = raw && typeof raw.cacheDir === "string" ? raw.cacheDir : undefined;
  if (explicit !== undefined) return isAbsolute(explicit) ? explicit : join(homedir(), explicit);
  return join(homedir(), ".obsidian-tc");
}

async function detect(
  cmd: Cmd<"setup">,
): Promise<SetupDecision & { targetPath: string; existingRaw?: Record<string, unknown> }> {
  const targetPath = cmd.configPath ?? defaultSetupConfigPath();
  const existing = loadExistingConfig(targetPath);
  const cacheDir = existing?.config?.cacheDir ?? rawCacheDirFallback(existing?.raw);

  const profile = await resolveCapabilityProfile({
    extraVaultPaths: cmd.vaultPath ? [resolve(cmd.vaultPath)] : [],
  });
  // Finding 7: a registry entry whose vault was since deleted/moved must not be reported as
  // detected — skip it with a printed warning rather than let it flow into a schema-valid config
  // that only fails much later, at serve/indexing time.
  const registryVaults: SetupVaultInput[] = [];
  for (const v of profile.obsidian.vaults) {
    if (isExistingDirectory(v.path)) {
      registryVaults.push({ id: v.id, path: v.path });
    } else {
      process.stderr.write(
        `obsidian-tc setup: skipping registry vault "${v.id}" — path no longer exists: ${v.path}\n`,
      );
    }
  }
  // Finding 2: an existing config's own vaults are the baseline — a headless machine with no
  // Obsidian registry entry (or one that predates it) must still detect vaults it already
  // configured, not just what the registry happens to list right now.
  const existingVaults =
    existing?.config?.vaults.map((v) => ({ id: v.id, path: v.path })) ?? rawVaults(existing?.raw);
  const seenIds = new Set(existingVaults.map((v) => v.id));
  const vaults = [...existingVaults, ...registryVaults.filter((v) => !seenIds.has(v.id))];

  // THE-522-shaped default identity, mirroring resolveServeConfigWithProvenance's own "configured"
  // shape for a schema-fresh install — this is only the INPUT to resolveStickyEmbeddings via
  // probeEmbeddingsProviderSource; an existing index's own identity always wins over it (see
  // decide.ts's own comment on `existingIndex` precedence).
  const existingIndex =
    vaults.length > 0
      ? await probeEmbeddingsProviderSource(cacheDir, DEFAULT_BUSY_TIMEOUT_MS, {
          providerExplicit: false,
          onProviderChange: "keep",
          configured: { provider: "local", model: "nomic-embed-text-v1.5", dimensions: 768 },
          vaultIds: vaults.map((v) => v.id),
        })
      : undefined;

  const localProbe = await probeLocalEmbedderResolution({ cacheDir });
  const platform = onnxNativePrebuildStatus();
  const localEmbedderAvailable = localProbe.ok && platform.supported;
  const localUnavailableReason = localEmbedderAvailable
    ? undefined
    : !platform.supported
      ? platform.note
      : localProbe.inSourceCheckout
        ? "not yet built in this source checkout — run `bun run build` in packages/embedder-local"
        : "the optional @the-40-thieves/obsidian-tc-embedder-local package did not resolve";

  const ollama = await probeOllama();

  const inputs: SetupInputs = {
    vaults,
    cacheDir,
    totalMemMb: profile.hardware.totalMemMb,
    ...(existingIndex ? { existingIndex } : {}),
    localEmbedderAvailable,
    ...(localUnavailableReason ? { localUnavailableReason } : {}),
    ollama,
    env: process.env,
  };
  return {
    ...decideSetup(inputs),
    targetPath,
    ...(existing ? { existingRaw: existing.raw } : {}),
  };
}

function printDecisions(
  decision: SetupDecision & { targetPath: string; existingRaw?: Record<string, unknown> },
): void {
  const out: string[] = [];
  out.push(`obsidian-tc setup — target: ${decision.targetPath}`, "");
  if (decision.vaults.length === 0) {
    out.push("vaults: NONE FOUND — no Obsidian registry and no --vault given.");
  } else {
    out.push("vaults:");
    for (const v of decision.vaults) out.push(`  - ${v.id}: ${v.path}`);
  }
  out.push(`cacheDir: ${decision.cacheDir}`);
  if (decision.refusal) {
    out.push("", `embeddings: REFUSED — ${decision.refusal}`);
  } else if (decision.embeddings) {
    out.push(
      `embeddings: provider=${decision.embeddings.provider} model=${decision.embeddings.model} dimensions=${decision.embeddings.dimensions}`,
      `  reason: ${decision.embeddings.reason}`,
    );
    if (decision.embeddings.notice) out.push(`  NOTICE: ${decision.embeddings.notice}`);
  }
  if (decision.hostedSuggestions.length > 0) {
    out.push(
      "",
      "hosted embeddings API keys detected in your environment (NOT chosen automatically — " +
        "obsidian-tc never sends note content to a third party without an explicit opt-in):",
    );
    for (const s of decision.hostedSuggestions) {
      out.push(
        `  - ${s.provider} (${s.envVar} is set) — to use it, set embeddings.provider: "${s.provider}" explicitly in your config.`,
      );
    }
  }
  out.push("");
  process.stdout.write(`${out.join("\n")}\n`);
}

/** No TTY -> behave like --dry-run unless --yes was given (an unattended script piping into stdin
 *  must never block on a prompt it can't answer, and must never write without having said --yes). */
async function confirmWrite(targetPath: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Write this config to ${targetPath}? [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function run_setup(cmd: Cmd<"setup">): Promise<void> {
  // Finding 7: validate --vault BEFORE any other I/O — a typo'd or removed path must never reach
  // resolveCapabilityProfile (which would happily fold it in as a "detected" vault) or produce a
  // schema-valid config whose vault path only turns out to be wrong at serve/indexing time.
  if (cmd.vaultPath !== undefined && !isExistingDirectory(resolve(cmd.vaultPath))) {
    process.stderr.write(
      `obsidian-tc setup: --vault ${cmd.vaultPath} does not exist or is not a directory.\n`,
    );
    process.exitCode = 2;
    return;
  }

  const decision = await detect(cmd);
  printDecisions(decision);

  if (decision.vaults.length === 0) {
    process.stderr.write(
      "obsidian-tc setup: no vault found — no Obsidian registry on this machine, and no --vault given. Pass --vault <path>.\n",
    );
    process.exitCode = 2;
    return;
  }

  // Findings 1 + 5: decideSetup refused to write a guessed/ambiguous embeddings provider — the
  // refusal is already printed by printDecisions above; stop here without ever building or
  // writing a config, dry-run or not.
  if (decision.refusal) {
    process.exitCode = 1;
    return;
  }

  const raw = buildSetupConfig(decision, decision.existingRaw);
  // Fix round 2, finding C (orchestrator): this runs on EVERY invocation, including a plain
  // --dry-run — an existing config's inline apiKey/secret must never reach stdout unredacted, the
  // same rule `config show` already applies to the same raw shape (cli/commands/config-show.ts).
  process.stdout.write(`${JSON.stringify(redactConfig(raw), null, 2)}\n`);

  if (cmd.dryRun) {
    process.stdout.write("(--dry-run: nothing written)\n");
    return;
  }

  if (!cmd.yes) {
    if (!process.stdin.isTTY) {
      process.stdout.write(
        "obsidian-tc setup: no TTY and --yes not given — nothing written. Re-run with --yes to write non-interactively.\n",
      );
      return;
    }
    const confirmed = await confirmWrite(decision.targetPath);
    if (!confirmed) {
      process.stdout.write("obsidian-tc setup: aborted — nothing written.\n");
      return;
    }
  }

  try {
    const result = writeSetupConfig(decision.targetPath, decision, {
      force: cmd.force,
      existingRaw: decision.existingRaw,
    });
    process.stdout.write(
      `obsidian-tc setup: wrote ${result.path}` +
        (result.backupPath ? ` (existing config backed up to ${result.backupPath})` : "") +
        `\nPoint obsidian-tc at it: pass it as --config, or set OBSIDIAN_TC_CONFIG=${result.path}.\n`,
    );
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
}
