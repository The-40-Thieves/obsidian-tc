// Shared by the write-safety tests: load vault/notes-io on the native backend or the pure-JS one, so
// every assertion runs against BOTH code paths (the native module closes the TOCTOU the JS path
// documents as residual; both must hold the same contract).
import { vi } from "vitest";

export type Backend = "native" | "js";
type NotesIo = typeof import("../src/vault/notes-io");

/** Fresh notes-io module on the requested backend, or null when native is unavailable (skip). */
export async function loadNotesIo(backend: Backend): Promise<NotesIo | null> {
  vi.resetModules();
  vi.unstubAllEnvs();
  if (backend === "js") vi.stubEnv("OBSIDIAN_TC_FORCE_JS_FALLBACK", "1");
  const io = await import("../src/vault/notes-io");
  if (backend === "native" && !io.nativeVaultIo) return null;
  if (backend === "js" && io.nativeVaultIo) throw new Error("JS backend requested, native loaded");
  return io;
}

/** Try to create a symlink; false when the host forbids it (Windows without privilege). */
export function trySymlink(
  fs: typeof import("node:fs"),
  target: string,
  link: string,
  type: "dir" | "file" = "dir",
): boolean {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch {
    return false;
  }
}
