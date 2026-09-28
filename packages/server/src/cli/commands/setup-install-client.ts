// PR B of GH #995's two-part follow-up (extended to Codex/ChatGPT/Antigravity/Hermes by a later
// change): the I/O glue for `obsidian-tc setup --install-client <client>` —
// cli/setup/client-install.ts owns every pure path-resolution/format/merge/registry decision;
// this file is only the filesystem/process boundary around it (reading an existing client config,
// running a client's own `mcp add`-style command, writing the merged file), same "I/O in the
// command file, pure logic in cli/setup/*" split cli/commands/setup.ts's own header documents for
// PR A. Dispatches on CLIENT_REGISTRY's `kind` rather than the client id directly, so a future
// registry entry (see that table's own header comment) needs no new branch here.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { CliError } from "../cli-error";
import { defaultSetupConfigPath } from "../resolve-config";
import {
  CLIENT_REGISTRY,
  clientLabel,
  formatCliInstallLine,
  mergeMcpServersEntry,
  obsidianTcServerEntry,
} from "../setup/client-install";
import { mergeJsonFileAtomic } from "../setup/write";
import type { Cmd } from "../shared";

/** Everything `runInstallClient` reads from the ambient environment, as one injectable bag —
 *  tests supply a fake platform/env/home (never the real host's) and a stub `runCli` (so a test
 *  run never actually shells out to a `claude`/`codex`/`agy`/`hermes` binary that may not exist,
 *  or may not be safe to invoke for real, on the CI runner — see this repo's own note that `agy`
 *  has no read-only mode). */
export interface InstallClientDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  /** Runs `<binary> mcp add ...` (or that client's equivalent) and returns its captured stdout, or
   *  throws (ENOENT when the binary isn't on PATH, or the command's own non-zero exit —
   *  `execFileSync` throws for both). One function for every `"cli"` registry entry, never a
   *  shell — the binary and its argv are both fixed by CLIENT_REGISTRY, not user input. */
  runCli: (binary: string, args: string[]) => string;
}

function defaultDeps(): InstallClientDeps {
  return {
    platform: process.platform,
    env: process.env,
    home: homedir(),
    runCli: (binary, args) =>
      execFileSync(binary, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
  };
}

/** Parses an existing MCP client config file as JSON, or undefined if it does not exist yet — a
 *  brand-new client install (no prior config at all) is exactly as mergeable as one with other
 *  servers already in it. An existing file that fails to parse is a real refusal (never silently
 *  treated as "nothing here", which would go on to CLOBBER whatever is actually in it). */
function loadExistingClientJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new CliError(`${path} exists but is not valid JSON — fix or remove it, then re-run.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError(
      `${path} exists but its top level is not a JSON object — fix it, then re-run.`,
    );
  }
  return parsed as Record<string, unknown>;
}

/** `obsidian-tc setup --install-client <client>`'s whole action. Never runs the normal
 *  detect/decide/write flow (cli/commands/setup.ts's own `run_setup` branches BEFORE that) — the
 *  config path a client is pointed at need not exist yet at all; `serve`'s own first-run fallback
 *  (cli/setup/first-run-fallback.ts) is what fills it in on first launch. */
export async function runInstallClient(
  cmd: Cmd<"setup">,
  deps: InstallClientDeps = defaultDeps(),
): Promise<void> {
  const client = cmd.installClient;
  if (client === undefined) {
    throw new Error("runInstallClient called without --install-client");
  }
  const targetConfigPath = cmd.configPath ?? defaultSetupConfigPath();
  const entry = CLIENT_REGISTRY[client];

  if (entry.kind === "instructions-only") {
    // ChatGPT (today's only entry of this kind): no local install mechanism exists at all — print
    // guidance and write nothing, regardless of --dry-run/--force/--yes.
    process.stdout.write(`${entry.instructions()}\n`);
    return;
  }

  if (entry.kind === "cli") {
    const args = entry.buildArgs(targetConfigPath);
    // Finding 6 (fix round, cross-vendor review, originally Claude Code-only): `deps.runCli` below
    // runs `args` directly (never a shell, so no quoting needed there) — this printed line is what
    // a human copy-pastes into THEIR shell, and must be quoted for it.
    process.stdout.write(`${formatCliInstallLine(entry.binary, args, deps.platform)}\n`);
    if (cmd.dryRun) {
      process.stdout.write("(--dry-run: not run)\n");
      return;
    }
    try {
      const output = deps.runCli(entry.binary, args);
      if (output.length > 0) process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
      process.stdout.write(
        `obsidian-tc setup: ran the command above via the ${entry.displayName} CLI.\n`,
      );
    } catch (e) {
      process.stderr.write(
        `obsidian-tc setup: could not run \`${entry.binary}\` (${e instanceof Error ? e.message : String(e)}) ` +
          "— run the command printed above yourself.\n",
      );
      process.exitCode = 1;
    }
    return;
  }

  // entry.kind === "json-merge" (Claude Desktop, Cursor today).
  const targetPath = entry.configPath(deps.platform, deps.env, deps.home);
  const existingRaw = loadExistingClientJson(targetPath);
  const result = mergeMcpServersEntry(
    existingRaw,
    targetConfigPath,
    { force: cmd.force },
    entry.serversKey,
  );
  if (result.alreadyExists) {
    process.stderr.write(
      `obsidian-tc setup: ${clientLabel(client)} already has an "obsidian-tc" MCP server entry ` +
        `at ${targetPath} — pass --force to overwrite it.\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (cmd.dryRun) {
    process.stdout.write(
      `${JSON.stringify({ [entry.serversKey]: { "obsidian-tc": obsidianTcServerEntry(targetConfigPath) } }, null, 2)}\n`,
    );
    process.stdout.write("(--dry-run: nothing written)\n");
    return;
  }

  const written = mergeJsonFileAtomic(targetPath, result.merged);
  process.stdout.write(
    `obsidian-tc setup: wrote ${clientLabel(client)}'s obsidian-tc entry to ${written.path}` +
      (written.backupPath ? ` (existing file backed up to ${written.backupPath})` : "") +
      "\n",
  );
}
