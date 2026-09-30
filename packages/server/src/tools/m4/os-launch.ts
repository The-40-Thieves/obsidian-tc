// OS URI-handler launcher for show_file_in_obsidian's fallback path. It hands ONE obsidian://open URI
// to the platform's URI handler, and is deliberately narrow:
//   - the URI must match assertSafeObsidianOpenUri (scheme exactly `obsidian`, action `open`, exactly
//     `vault` then `file`, every value percent-encoded) — it is never a raw caller string;
//   - the command is spawned with an argv ARRAY and `shell: false`, so no metacharacter in a note name
//     can be interpreted by a shell. The URI is one argv element and always starts with `obsidian://`,
//     so it can never be read as an option flag either;
//   - Windows uses rundll32 url.dll,FileProtocolHandler by absolute path (ShellExecute of the URL, no
//     cmd.exe; `cmd /c start "" <uri>` would re-parse `&` and `%` in a shell). libuv searches the
//     current directory before PATH on Windows, hence the absolute path;
//   - stdio is "ignore": nothing the handler prints is captured, so nothing can be logged or echoed;
//   - a timeout kills a launcher that never returns.
import { spawn } from "node:child_process";
import { win32 } from "node:path";
import { err } from "@the-40-thieves/obsidian-tc-shared";

export type OsLaunchFailure =
  | "unsupported_platform"
  | "no_display"
  | "launcher_not_found"
  | "spawn_error"
  | "exit_nonzero"
  | "timeout";

export type OsLaunchResult = { ok: true } | { ok: false; reason: OsLaunchFailure };

/** The launch seam a tool takes; the URI is the only argument, so a caller cannot pass anything else. */
export type OsLaunchFn = (uri: string) => Promise<OsLaunchResult>;

export const OS_LAUNCH_TIMEOUT_MS = 5000;

// encodeURIComponent output plus its unreserved marks; `%` only as a well-formed escape.
const VALUE = "(?:[A-Za-z0-9._~!*'()-]|%[0-9A-Fa-f]{2})+";
const SAFE_OPEN_URI = new RegExp(`^obsidian://open\\?vault=${VALUE}&file=${VALUE}$`);

/** Throw invalid_input unless `uri` is exactly the shape buildObsidianUri("open", { file }, vault) emits. */
export function assertSafeObsidianOpenUri(uri: string): void {
  if (!SAFE_OPEN_URI.test(uri))
    throw err.invalidInput("refusing to launch a URI that is not a plain obsidian://open URI");
}

/** The handler command for `platform`, or undefined when the platform has none. */
export function osLaunchCommand(
  platform: NodeJS.Platform,
  uri: string,
  env: NodeJS.ProcessEnv,
): { command: string; args: string[] } | undefined {
  switch (platform) {
    case "linux":
      return { command: "xdg-open", args: [uri] };
    case "darwin":
      return { command: "/usr/bin/open", args: [uri] };
    case "win32":
      return {
        command: win32.join(env.SystemRoot ?? "C:\\Windows", "System32", "rundll32.exe"),
        args: ["url.dll,FileProtocolHandler", uri],
      };
    default:
      return undefined;
  }
}

export interface OsLaunchOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawnFn?: typeof spawn;
  timeoutMs?: number;
}

/** Validate `uri`, then spawn the platform handler for it. Resolves with the outcome; throws only on an unsafe URI. */
export async function launchOsUri(
  uri: string,
  opts: OsLaunchOptions = {},
): Promise<OsLaunchResult> {
  assertSafeObsidianOpenUri(uri);
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const cmd = osLaunchCommand(platform, uri, env);
  if (!cmd) return Promise.resolve({ ok: false, reason: "unsupported_platform" });
  // No display server means xdg-open has nothing to hand the URI to; say so rather than spawn.
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY)
    return Promise.resolve({ ok: false, reason: "no_display" });

  const spawnFn = opts.spawnFn ?? spawn;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (r: OsLaunchResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawnFn(cmd.command, cmd.args, {
      stdio: "ignore",
      shell: false,
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      settle({ ok: false, reason: "timeout" });
    }, opts.timeoutMs ?? OS_LAUNCH_TIMEOUT_MS);
    child.once("error", (e: NodeJS.ErrnoException) =>
      settle({ ok: false, reason: e.code === "ENOENT" ? "launcher_not_found" : "spawn_error" }),
    );
    child.once("exit", (code) =>
      settle(code === 0 ? { ok: true } : { ok: false, reason: "exit_nonzero" }),
    );
  });
}
