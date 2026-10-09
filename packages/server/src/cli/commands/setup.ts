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
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import * as readline from "node:readline/promises";
import { ObsidianTcError, type ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import { baselineOnlyEnrichment } from "../../capability/hardware";
import { resolveCapabilityProfile } from "../../capability/profile";
import { ConfigRootTypeError, finalizeConfig, readConfigFile } from "../../config/load";
import { DEFAULT_BUSY_TIMEOUT_MS } from "../../db/pragmas";
import { probeLocalEmbedderResolution } from "../../providers/local-embedder-registry";
import { onnxNativePrebuildStatus } from "../../providers/reranker-preflight";
import { redactConfig } from "../redact-config";
import { configIssueLines, defaultSetupConfigPath } from "../resolve-config";
import { formatClientSnippets } from "../setup/client-install";
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
import { runInstallClient } from "./setup-install-client";

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
 *  names one), load it through the REAL loader, never a hard-coded `~/.obsidian-tc` guess. Returns
 *  the raw (pre-default) object whenever the file at least PARSES as JSON, and the finalized config
 *  too when it validates. The two diverge for the pre-1.31.4 / GH #995 victim shape (vaults, no
 *  `embeddings`, no `cacheDir`): it fails `finalizeConfig` with a named `ObsidianTcError`, but it is
 *  a real config, and dropping its `raw` made `--force` discard every key setup does not own
 *  (`auth`, `acl`, ...). `undefined` ONLY when the file cannot be parsed as JSON at all.
 *  A file that parses but fails schema validation (a raw `ZodError`) comes back with `invalid` set
 *  to the offending fields, and `run_setup` refuses to write over it. A file that cannot be read as
 *  a JSON OBJECT at all (malformed JSON, a non-object root, unreadable) is `invalid` too: only an
 *  ABSENT file is `undefined` ("cannot read it" is not "nothing there"). */
function loadExistingConfig(
  targetPath: string,
): { raw: Record<string, unknown>; config?: ServerConfig; invalid?: string[] } | undefined {
  if (!existsSync(targetPath)) return undefined;
  let raw: Record<string, unknown>;
  try {
    raw = readConfigFile(targetPath);
  } catch (e) {
    return { raw: {}, invalid: [unreadableConfigLine(targetPath, e)] };
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
    // schema validation — return `raw` so buildSetupConfig can merge into it.
    if (e instanceof ObsidianTcError) return { raw };
    // Was `undefined` ("no existing config"): `--force` then rebuilt from `{}` and replaced a
    // restrictive acl/auth/egress with defaults. Refused, not merged: see `run_setup`.
    if (e instanceof z.ZodError) return { raw, invalid: configIssueLines(e) };
    return undefined;
  }
}

const ROOT_TYPE_PHRASE: Record<ConfigRootTypeError["rootType"], string> = {
  null: "null",
  array: "an array",
  number: "a number",
  string: "a string",
  boolean: "a boolean",
  other: "not an object",
};

/** `line L, column C` for a `position N` a JSON parse error reports; "" when the engine gave none
 *  (Bun) or already printed its own line/column. Best effort. */
function parseErrorLocation(path: string, message: string): string {
  if (/\bline \d+/i.test(message)) return "";
  const position = /position (\d+)/.exec(message)?.[1];
  if (position === undefined) return "";
  try {
    const before = readFileSync(path, "utf8")
      .replace(/^\uFEFF/, "")
      .slice(0, Number(position));
    const lines = before.split("\n");
    return ` (line ${lines.length}, column ${(lines.at(-1) ?? "").length + 1})`;
  } catch {
    return "";
  }
}

/** One `invalid` line for a config file `readConfigFile` could not turn into an object. */
function unreadableConfigLine(path: string, e: unknown): string {
  if (e instanceof ConfigRootTypeError) {
    return `config root is ${ROOT_TYPE_PHRASE[e.rootType]}; it must be a JSON object`;
  }
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof SyntaxError) {
    return `file is not valid JSON: ${message}${parseErrorLocation(path, message)}`;
  }
  return `file could not be read: ${message}`;
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

/** Setup hardening item 1: an existing config's own vault paths were never existence-checked —
 *  only freshly-detected registry vaults were (via `isExistingDirectory` above). Missing paths are
 *  WARNED, never dropped: an operator's own prior config entry is not setup's to delete just
 *  because e.g. a USB/NFS mount isn't attached right now (mirrors `isExistingDirectory`'s own
 *  tolerance for a `stat` throw). */
function missingExistingVaultWarnings(existingVaults: SetupVaultInput[]): string[] {
  return existingVaults
    .filter((v) => !isExistingDirectory(v.path))
    .map(
      (v) =>
        `obsidian-tc setup: existing config vault "${v.id}" path no longer exists: ${v.path} — ` +
        "kept as-is (not deleted); fix or remove it by hand if this is stale.",
    );
}

/** Setup hardening item 1: a vault id present in BOTH the existing config and a LIVE Obsidian
 *  registry entry, at two DIFFERENT paths, must never resolve silently. Before this fix,
 *  `buildSetupConfig`'s existing-id-wins union meant the existing (possibly stale) path always won
 *  with no signal at all that the registry now disagrees — e.g. the vault was moved and
 *  re-registered in Obsidian under the same id. Surfaced instead, and refused even with
 *  `--yes`/`--force` together (see `run_setup`'s own check) — the operator resolves by hand. */
export interface VaultIdCollision {
  id: string;
  existingPath: string;
  registryPath: string;
}

function findVaultIdCollisions(
  existingVaults: SetupVaultInput[],
  registryVaults: SetupVaultInput[],
): VaultIdCollision[] {
  const existingById = new Map(existingVaults.map((v) => [v.id, v.path]));
  const collisions: VaultIdCollision[] = [];
  for (const rv of registryVaults) {
    const existingPath = existingById.get(rv.id);
    if (existingPath !== undefined && existingPath !== rv.path) {
      collisions.push({ id: rv.id, existingPath, registryPath: rv.path });
    }
  }
  return collisions;
}

/** Exported for cli/setup/first-run-fallback.ts (PR B of GH #995's two-part follow-up): `serve`'s
 *  own first-run fallback reuses this SAME detection pass — never a second, drifting
 *  re-implementation — non-interactively, when there is no config to boot from at all. See that
 *  module's own header for the safety conditions it applies to the result. */
export async function detect(cmd: Cmd<"setup">): Promise<
  SetupDecision & {
    targetPath: string;
    existingRaw?: Record<string, unknown>;
    /** `field: reason` lines when the existing config fails validation (`run_setup` refuses). */
    existingInvalid?: string[];
    /** Finding 4 (fix round, cross-vendor review): the RAW Obsidian registry count, before
     *  `isExistingDirectory` drops entries whose vault path no longer stats (unplugged USB/NFS
     *  mount, a transient `stat` throw). Exported so first-run-fallback.ts can decline on ambiguity
     *  even when only ONE vault happened to survive filtering — see that module's own comment on
     *  why `decision.vaults.length` alone is not a safe signal for the no-operator-watching case. */
    registryVaultCount: number;
    /** Setup hardening item 1 — see `missingExistingVaultWarnings`'s own doc comment. Already
     *  printed to stderr by `detect` itself (the same point registry-vault warnings print from),
     *  and carried on the return value only so callers/tests can assert on it directly. */
    missingVaultWarnings: string[];
    /** Setup hardening item 1 — see `findVaultIdCollisions`'s own doc comment. Non-empty blocks
     *  `run_setup` from writing, even with `--yes`/`--force`. */
    vaultIdCollisions: VaultIdCollision[];
  }
> {
  const targetPath = cmd.configPath ?? defaultSetupConfigPath();
  const existing = loadExistingConfig(targetPath);
  const cacheDir = existing?.config?.cacheDir ?? rawCacheDirFallback(existing?.raw);

  const profile = await resolveCapabilityProfile({
    extraVaultPaths: cmd.vaultPath ? [resolve(cmd.vaultPath)] : [],
    enrich: baselineOnlyEnrichment,
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
  const missingVaultWarnings = missingExistingVaultWarnings(existingVaults);
  for (const w of missingVaultWarnings) process.stderr.write(`${w}\n`);
  const vaultIdCollisions = findVaultIdCollisions(existingVaults, registryVaults);
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
    registryVaultCount: profile.obsidian.vaults.length,
    missingVaultWarnings,
    vaultIdCollisions,
    ...(existing ? { existingRaw: existing.raw } : {}),
    ...(existing?.invalid ? { existingInvalid: existing.invalid } : {}),
  };
}

function printDecisions(
  decision: SetupDecision & {
    targetPath: string;
    existingRaw?: Record<string, unknown>;
    vaultIdCollisions: VaultIdCollision[];
  },
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
  if (decision.vaultIdCollisions.length > 0) {
    out.push("", "VAULT ID COLLISIONS — resolve by hand before writing (setup will not guess):");
    for (const c of decision.vaultIdCollisions) {
      out.push(
        `  - "${c.id}": existing config has ${c.existingPath}, but the Obsidian registry now ` +
          `has a DIFFERENT path for the same id: ${c.registryPath}`,
        `    Decide which is correct, then edit the config's vaults[] entry for "${c.id}" by ` +
          "hand and re-run.",
      );
    }
  }
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
  // PR B of GH #995's two-part follow-up: `--install-client` is a SEPARATE action from the normal
  // detect/decide/write flow below — it never runs vault detection at all, only wires an
  // `obsidian-tc` entry into the named client's own MCP config. See
  // cli/commands/setup-install-client.ts.
  if (cmd.installClient !== undefined) {
    try {
      await runInstallClient(cmd);
    } catch (e) {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    }
    return;
  }

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
  // Never rewritten by --force/--yes/--dry-run: rebuilding from defaults can loosen the rule the
  // file carried. Only `--replace-invalid-config` (never implied by --force) may, loudly.
  if (decision.existingInvalid) {
    if (!cmd.replaceInvalidConfig) {
      process.stderr.write(
        `obsidian-tc setup: refusing to touch ${decision.targetPath} — it is not a valid config, ` +
          "and setup will not rewrite a config it cannot read back, since that could replace your " +
          "restrictive acl/auth/egress settings with defaults. Nothing was written.\n" +
          `  ${decision.existingInvalid.join("\n  ")}\n` +
          "Fix the problem above by hand (a backup is not needed: the file is untouched), then " +
          "re-run `obsidian-tc setup`. To throw the old file away on purpose and write a fresh " +
          "default one (the old file is backed up first), pass `--replace-invalid-config`.\n",
      );
      process.exitCode = 1;
      return;
    }
    process.stderr.write(
      `obsidian-tc setup: WARNING: --replace-invalid-config: ${decision.targetPath} is not a ` +
        "valid config and will be REPLACED. Its acl, auth and egress settings, and every other " +
        "setting in it, are DISCARDED and rebuilt from defaults; the old file is kept as a " +
        "backup (<path>.bak-<timestamp>) when this run writes. Problems found:\n" +
        `  ${decision.existingInvalid.join("\n  ")}\n`,
    );
  }
  // Replacing: nothing from the invalid file is merged back in.
  const existingRaw = decision.existingInvalid ? undefined : decision.existingRaw;
  printDecisions(decision);
  // PR B: without --install-client, `setup` prints ready-to-paste snippets for all three known
  // clients — the manual alternative to the opt-in installer. Shown regardless of outcome below
  // (even a refusal or a 0-vault run): the config path is known either way, and `serve`'s own
  // first-run fallback can fill it in later even if this run wrote nothing.
  process.stdout.write(
    formatClientSnippets(decision.targetPath, process.platform, process.env, homedir()),
  );

  if (decision.vaults.length === 0) {
    process.stderr.write(
      "obsidian-tc setup: no vault found — no Obsidian registry on this machine, and no --vault given. Pass --vault <path>.\n",
    );
    process.exitCode = 2;
    return;
  }

  // Setup hardening item 1: a vault id collision between the existing config and a live registry
  // entry is already printed above — stop here, unconditionally (never auto-resolved by --yes or
  // --force together), rather than let buildSetupConfig's existing-id-wins union pick one silently.
  if (decision.vaultIdCollisions.length > 0) {
    process.exitCode = 1;
    return;
  }

  // Findings 1 + 5: decideSetup refused to write a guessed/ambiguous embeddings provider — the
  // refusal is already printed by printDecisions above; stop here without ever building or
  // writing a config, dry-run or not.
  if (decision.refusal) {
    process.exitCode = 1;
    return;
  }

  const raw = buildSetupConfig(decision, existingRaw);
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
      force: cmd.force || cmd.replaceInvalidConfig === true,
      existingRaw,
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
