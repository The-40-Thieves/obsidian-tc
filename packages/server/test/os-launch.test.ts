// show_file_in_obsidian's OS-handler fallback: the launcher spawns the platform URI handler with an
// argv ARRAY (never a shell) and refuses anything that is not an obsidian://open URI built by
// buildObsidianUri. spawn is stubbed, so every assertion is on the exact command + argv + options.

import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it, vi } from "vitest";
import { assertSafeObsidianOpenUri, launchOsUri, osLaunchCommand } from "../src/tools/m4/os-launch";
import { buildObsidianUri } from "../src/tools/m6/uri-tools";

type SpawnCall = { command: string; args: readonly string[]; options: Record<string, unknown> };

/** A stub `spawn` whose child runs `script` on the next tick. */
function stubSpawn(script: (child: EventEmitter & { kill: ReturnType<typeof vi.fn> }) => void) {
  const calls: SpawnCall[] = [];
  const kill = vi.fn();
  const fn = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    const child = Object.assign(new EventEmitter(), { kill });
    queueMicrotask(() => script(child));
    return child;
  }) as unknown as typeof spawn;
  return { fn, calls, kill };
}

const URI = "obsidian://open?vault=My%20Vault&file=Notes%2Fa%20b.md";
const GUI_ENV = { DISPLAY: ":0" } as NodeJS.ProcessEnv;

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof ObsidianTcError ? e.code : "non-tc-error";
  }
  return "no-error";
}

describe("osLaunchCommand — exact argv per platform (no shell)", () => {
  it("linux: xdg-open <uri>", () => {
    expect(osLaunchCommand("linux", URI, {})).toEqual({ command: "xdg-open", args: [URI] });
  });
  it("darwin: /usr/bin/open <uri>", () => {
    expect(osLaunchCommand("darwin", URI, {})).toEqual({ command: "/usr/bin/open", args: [URI] });
  });
  it("win32: rundll32 url.dll,FileProtocolHandler <uri> by absolute path, never cmd /c start", () => {
    const cmd = osLaunchCommand("win32", URI, { SystemRoot: "C:\\Windows" });
    expect(cmd).toEqual({
      command: "C:\\Windows\\System32\\rundll32.exe",
      args: ["url.dll,FileProtocolHandler", URI],
    });
    expect(cmd?.command.toLowerCase()).not.toContain("cmd");
  });
  it("win32 without SystemRoot falls back to C:\\Windows", () => {
    expect(osLaunchCommand("win32", URI, {})?.command).toBe("C:\\Windows\\System32\\rundll32.exe");
  });
  it("an unsupported platform has no launcher", () => {
    expect(osLaunchCommand("aix", URI, {})).toBeUndefined();
  });
});

describe("assertSafeObsidianOpenUri — strict validation", () => {
  it("accepts a URI built by buildObsidianUri('open')", () => {
    expect(() =>
      assertSafeObsidianOpenUri(buildObsidianUri("open", { file: "Notes/a b.md" }, "My Vault")),
    ).not.toThrow();
  });

  it.each([
    ["file scheme", "file:///etc/passwd"],
    ["https scheme", "https://example.com/?vault=a&file=b"],
    ["javascript scheme", "javascript:alert(1)"],
    ["uppercase scheme", "OBSIDIAN://open?vault=a&file=b"],
    ["other obsidian action", "obsidian://advanced-uri?vault=a&file=b"],
    ["new action (content injection)", "obsidian://new?vault=a&file=b&content=x"],
    ["extra param", "obsidian://open?vault=a&file=b&extra=1"],
    ["missing vault", "obsidian://open?file=b"],
    ["reordered params", "obsidian://open?file=b&vault=a"],
    ["raw quote", 'obsidian://open?vault=a&file=b"c'],
    ["raw semicolon", "obsidian://open?vault=a&file=b;rm"],
    ["raw space", "obsidian://open?vault=a&file=b c"],
    ["raw newline", "obsidian://open?vault=a&file=b\nc"],
    ["raw dollar-paren", "obsidian://open?vault=a&file=$(id)"],
    ["raw backtick", "obsidian://open?vault=a&file=`id`"],
    ["raw pipe", "obsidian://open?vault=a&file=b|c"],
    ["raw ampersand inside value", "obsidian://open?vault=a&file=b&c"],
    ["truncated percent escape", "obsidian://open?vault=a&file=b%2"],
    ["leading whitespace", " obsidian://open?vault=a&file=b"],
    ["empty", ""],
  ])("refuses %s", (_label, uri) => {
    expect(code(() => assertSafeObsidianOpenUri(uri))).toBe("invalid_input");
  });
});

describe("launchOsUri", () => {
  it("spawns xdg-open with the URI as ONE argv element, no shell, no stdio capture", async () => {
    const s = stubSpawn((c) => c.emit("exit", 0, null));
    const res = await launchOsUri(URI, { platform: "linux", env: GUI_ENV, spawnFn: s.fn });
    expect(res).toEqual({ ok: true });
    expect(s.calls).toHaveLength(1);
    const call = s.calls[0] as SpawnCall;
    expect(call.command).toBe("xdg-open");
    expect(call.args).toEqual([URI]);
    expect(call.options.shell).toBeFalsy();
    expect(call.options.stdio).toBe("ignore");
    expect(call.options.windowsHide).toBe(true);
  });

  it("spawns rundll32 on win32 (no cmd, no shell)", async () => {
    const s = stubSpawn((c) => c.emit("exit", 0, null));
    await launchOsUri(URI, {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" } as NodeJS.ProcessEnv,
      spawnFn: s.fn,
    });
    const call = s.calls[0] as SpawnCall;
    expect(call.command).toBe("C:\\Windows\\System32\\rundll32.exe");
    expect(call.args).toEqual(["url.dll,FileProtocolHandler", URI]);
    expect(call.options.shell).toBeFalsy();
  });

  it("refuses an unsafe URI before spawning anything", async () => {
    const s = stubSpawn((c) => c.emit("exit", 0, null));
    await expect(
      launchOsUri("file:///etc/passwd", { platform: "linux", env: GUI_ENV, spawnFn: s.fn }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(s.calls).toHaveLength(0);
  });

  it("linux with no display: no_display, nothing spawned", async () => {
    const s = stubSpawn((c) => c.emit("exit", 0, null));
    const res = await launchOsUri(URI, { platform: "linux", env: {}, spawnFn: s.fn });
    expect(res).toEqual({ ok: false, reason: "no_display" });
    expect(s.calls).toHaveLength(0);
  });

  it("linux with WAYLAND_DISPLAY only is launchable", async () => {
    const s = stubSpawn((c) => c.emit("exit", 0, null));
    const res = await launchOsUri(URI, {
      platform: "linux",
      env: { WAYLAND_DISPLAY: "wayland-0" } as NodeJS.ProcessEnv,
      spawnFn: s.fn,
    });
    expect(res).toEqual({ ok: true });
  });

  it("ENOENT from spawn: launcher_not_found", async () => {
    const s = stubSpawn((c) =>
      c.emit("error", Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" })),
    );
    const res = await launchOsUri(URI, { platform: "linux", env: GUI_ENV, spawnFn: s.fn });
    expect(res).toEqual({ ok: false, reason: "launcher_not_found" });
  });

  it("any other spawn error: spawn_error", async () => {
    const s = stubSpawn((c) =>
      c.emit("error", Object.assign(new Error("boom"), { code: "EACCES" })),
    );
    const res = await launchOsUri(URI, { platform: "linux", env: GUI_ENV, spawnFn: s.fn });
    expect(res).toEqual({ ok: false, reason: "spawn_error" });
  });

  it("non-zero exit: exit_nonzero", async () => {
    const s = stubSpawn((c) => c.emit("exit", 3, null));
    const res = await launchOsUri(URI, { platform: "linux", env: GUI_ENV, spawnFn: s.fn });
    expect(res).toEqual({ ok: false, reason: "exit_nonzero" });
  });

  it("a launcher that never returns is killed and reported as timeout", async () => {
    const s = stubSpawn(() => {});
    const res = await launchOsUri(URI, {
      platform: "linux",
      env: GUI_ENV,
      spawnFn: s.fn,
      timeoutMs: 20,
    });
    expect(res).toEqual({ ok: false, reason: "timeout" });
    expect(s.kill).toHaveBeenCalledTimes(1);
  });

  it("unsupported platform: unsupported_platform, nothing spawned", async () => {
    const s = stubSpawn((c) => c.emit("exit", 0, null));
    const res = await launchOsUri(URI, { platform: "aix", env: GUI_ENV, spawnFn: s.fn });
    expect(res).toEqual({ ok: false, reason: "unsupported_platform" });
    expect(s.calls).toHaveLength(0);
  });
});

describe("injection attempts stay one encoded argv element", () => {
  const nasty = [
    'Notes/say "hi".md',
    "Notes/a&b.md",
    "Notes/a;rm -rf ~.md",
    "Notes/line1\nline2.md",
    "Notes/$(id).md",
    "Notes/`id`.md",
    "Notes/a|b>c.md",
    "Notes/q?x=1#frag.md",
    "Notes/日本語 ノート.md",
  ];
  it.each(nasty)("%j", async (rel) => {
    const uri = buildObsidianUri("open", { file: rel }, 'My "Vault"; $(id)');
    const s = stubSpawn((c) => c.emit("exit", 0, null));
    const res = await launchOsUri(uri, { platform: "linux", env: GUI_ENV, spawnFn: s.fn });
    expect(res).toEqual({ ok: true });
    const call = s.calls[0] as SpawnCall;
    expect(call.args).toHaveLength(1);
    const arg = call.args[0] as string;
    expect(arg).toBe(uri);
    // No shell metacharacter or whitespace survives raw; the file round-trips through decoding.
    expect(arg).not.toMatch(/["`;|<>\s$\\]/);
    const file = new URL(arg).searchParams.get("file");
    expect(file).toBe(rel);
  });
});
