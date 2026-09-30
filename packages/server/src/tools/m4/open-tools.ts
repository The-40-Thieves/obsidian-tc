// show_file_in_obsidian — actually OPEN a note in Obsidian on the host. generate_uri (m6) only builds
// an obsidian:// string; this is the launch it never did. Two paths, in order:
//   1. the companion bridge (POST /files/open) when a live Obsidian session answers for the vault;
//   2. the OS URI handler, ONLY when `uri.allowOsLaunch` is on AND the call came in over stdio —
//      a launch on the server host is meaningless (and unsafe) for an HTTP caller elsewhere.
// Neither available -> a structured `available: false` with a reason and a hint, never a silent success.
//
// Gating follows execute_command / trigger_quickadd: `execute:uri` is in the execute family, a
// hardcoded HITL floor, and rate-limited under the execute tier. Both paths first pass the vault's
// READ ACL (declared as `pathAcl`, so dispatch enforces it centrally, and re-checked here) and an
// existence check, so a note the caller cannot read is never revealed by being opened. The OS path
// launches only a URI rebuilt by buildObsidianUri from that vault-relative path — never a raw URI.
import { err, VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import { enforcePathAcl } from "../../vault/acl-path";
import { noteExists } from "../../vault/notes-io";
import { normalizeVaultPath, resolveVaultPath } from "../../vault/paths";
import { defineTool } from "../m1/define";
import { buildObsidianUri } from "../m6/uri-tools";
import { launchOsUri, type OsLaunchFailure } from "./os-launch";
import { bridgeTimeouts, companionUnreachable, type M4Deps, openCompanionBridge } from "./shared";

const UNAVAILABLE_REASONS = [
  "os_launch_disabled",
  "os_launch_requires_stdio",
  "os_launch_failed",
] as const;

const ShowFileOutput = z.union([
  z.object({
    available: z.literal(true),
    vault: z.string(),
    path: z.string(),
    method: z.enum(["bridge", "os"]),
  }),
  z.object({
    available: z.literal(false),
    vault: z.string(),
    path: z.string(),
    reason: z.enum(UNAVAILABLE_REASONS),
    /** Why the OS launcher failed (os_launch_failed only). */
    detail: z.string().optional(),
    message: z.string(),
    hint: z.string(),
  }),
]);

const BRIDGE_HINT =
  "Start Obsidian with the obsidian-tc companion plugin and Local REST API enabled for this vault, then retry.";
const BRIDGE_TOO_OLD_HINT =
  "The companion plugin is too old to open files; update the companion plugin inside Obsidian.";
const OS_DISABLED_HINT =
  "Or set `uri.allowOsLaunch: true` in the server config (local stdio installs only) so the server can hand the URI to this machine's URI handler.";
const OS_STDIO_HINT =
  "OS launch is honoured only on the local stdio transport; it is refused over HTTP because the launch would happen on the server host.";

const LAUNCH_FAILURE_HINT: Record<OsLaunchFailure, string> = {
  unsupported_platform:
    "This platform has no supported OS URI handler; open the note in Obsidian directly.",
  no_display:
    "This host has no display server (DISPLAY/WAYLAND_DISPLAY unset), so there is nothing to open Obsidian on.",
  launcher_not_found:
    "The platform URI opener (xdg-open, open or rundll32) was not found on this host.",
  spawn_error: "The platform URI opener could not be started.",
  exit_nonzero:
    "The platform URI opener failed; check that Obsidian is installed and registered for obsidian:// links.",
  timeout:
    "The platform URI opener did not return in time; Obsidian may still be starting, so retry shortly.",
};

export function buildOpenTools(deps: M4Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "show_file_in_obsidian",
      domain: "automation",
      vaultArg: "vault",
      description:
        "Open a vault note in the running Obsidian app. Tries the companion plugin first (a live Obsidian session for the vault); falls back to the OS obsidian:// URI handler only when `uri.allowOsLaunch` is enabled and the call arrives over stdio. When neither is available it returns available:false with a reason and a hint instead of a silent success. Always requires human confirmation (execute:uri is a HITL floor): it causes a host-side effect. The path must pass the read ACL and name an existing note. generate_uri remains the pure URI builder.",
      inputSchema: z.object({ vault: VaultId, path: VaultPath }).strict(),
      outputSchema: ShowFileOutput,
      requiredScopes: ["execute:uri"],
      tags: ["plugin-bridge"],
      // The confirmation binds on the note named here (its existence/content state) plus args_hash.
      pathAcl: (input) => [{ op: "read", path: input.path }],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        const abs = resolveVaultPath(v.root, rel);
        enforcePathAcl(ctx.acl, "read", rel, v.root, ctx.grantedScopes);
        const ex = noteExists(abs);
        if (!ex.exists || ex.type === "folder")
          throw err.noteNotFound("note not found", { vault: v.id, path: rel });

        // Path 1: a live Obsidian session, through the companion.
        let bridgeHint = BRIDGE_HINT;
        try {
          const { client } = openCompanionBridge(deps, v.id);
          await client.request({
            method: "POST",
            path: "/files/open",
            body: { path: rel },
            plugin: "obsidian-tc-companion",
            timeoutMs: bridgeTimeouts(deps, v.id).timeoutMs,
          });
          return { available: true as const, vault: v.id, path: rel, method: "bridge" as const };
        } catch (e) {
          // Only "no working companion path" falls through. plugin_incompatible and a bridge-side
          // refusal (invalid_input: Obsidian does not know the file) are answers, not absences.
          if (!companionUnreachable(e)) throw e;
          if (e.details?.http_status === 404) bridgeHint = BRIDGE_TOO_OLD_HINT;
        }

        const no = (
          reason: (typeof UNAVAILABLE_REASONS)[number],
          hint: string,
          detail?: string,
        ) => ({
          available: false as const,
          vault: v.id,
          path: rel,
          reason,
          ...(detail ? { detail } : {}),
          message:
            "Could not open the note in Obsidian: no live Obsidian session answered and the OS launch did not run.",
          hint,
        });

        // Path 2: the OS URI handler — opt-in, and only for the operator's own stdio process.
        if (deps.uri?.allowOsLaunch !== true)
          return no("os_launch_disabled", `${bridgeHint} ${OS_DISABLED_HINT}`);
        if (ctx.transport !== "stdio")
          return no("os_launch_requires_stdio", `${bridgeHint} ${OS_STDIO_HINT}`);

        // Rebuilt from the vault-relative path that just passed the ACL; the launcher re-validates it.
        const uri = buildObsidianUri("open", { file: rel }, v.name);
        const launched = await (deps.osLaunch ?? launchOsUri)(uri);
        if (launched.ok)
          return { available: true as const, vault: v.id, path: rel, method: "os" as const };
        return {
          ...no("os_launch_failed", LAUNCH_FAILURE_HINT[launched.reason], launched.reason),
          message: "Could not open the note in Obsidian: the OS URI handler did not complete.",
        };
      },
    }),
  ];
}
