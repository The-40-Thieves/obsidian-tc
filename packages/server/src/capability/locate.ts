// THE-522 — locating the obsidian.json registry across platforms.
//
// Paths are from Obsidian's own help repo (obsidianmd/obsidian-help, "How Obsidian stores data"):
//   macOS   ~/Library/Application Support/obsidian
//   Windows %APPDATA%\Obsidian
//   Linux   $XDG_CONFIG_HOME/obsidian  (or ~/.config/obsidian)
// The registry file itself is obsidian.json inside that folder (confirmed empirically on Linux).
//
// registryCandidates is a PURE function of (platform, env, home) so every OS branch is testable off
// that OS. It returns an ORDERED candidate list rather than one path because a box may have the
// config in a sandbox-relocated spot (Flatpak/Snap), and because auto-location is only ever a
// convenience — the explicit-path and filesystem-scan strategies work with no registry at all.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

const REGISTRY_FILE = "obsidian.json";

/**
 * Ordered obsidian.json candidate paths for a platform. `env`/`home` are injected so the function is
 * deterministic and testable; the live locator passes process.env and os.homedir(). An unknown
 * platform returns [] rather than throwing.
 */
export function registryCandidates(
  platform: NodeJS.Platform | string,
  env: Record<string, string | undefined>,
  home: string,
): string[] {
  // Join with the TARGET platform's separator, not the host's: this function computes the path for
  // `platform`, which may differ from process.platform (the whole point of it being testable off
  // that OS). Using the host-default `join` would emit backslashes when a Windows CI box computes a
  // macOS path — wrong, and it broke cross-platform CI.
  switch (platform) {
    case "darwin":
      return [posix.join(home, "Library", "Application Support", "obsidian", REGISTRY_FILE)];
    case "win32": {
      const appData = env.APPDATA ?? win32.join(home, "AppData", "Roaming");
      return [win32.join(appData, "Obsidian", REGISTRY_FILE)];
    }
    case "linux": {
      const xdg = env.XDG_CONFIG_HOME ?? posix.join(home, ".config");
      return [
        posix.join(xdg, "obsidian", REGISTRY_FILE),
        // Flatpak/Snap relocate the config out of ~/.config; a single path would miss these installs.
        posix.join(home, ".var", "app", "md.obsidian.Obsidian", "config", "obsidian", REGISTRY_FILE),
        posix.join(home, "snap", "obsidian", "current", ".config", "obsidian", REGISTRY_FILE),
      ];
    }
    default:
      return [];
  }
}

/** The first existing registry path for this machine, or null when no registry is present. */
export function locateRegistry(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string | null {
  for (const candidate of registryCandidates(platform, env, home)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
