// THE-522 — plugin manifest parsing.
//
// The manifest is a documented contract (docs.obsidian.md/Reference/Manifest) with NO published
// JSON Schema, and the files are written by third parties (the community installer, BRAT, dev
// builds, hand edits). We therefore hand-write the Zod schema from the docs and safeParse
// defensively: a bad manifest becomes a typed "unreadable" result naming the folder, never a throw
// that would abort a whole-vault scan.
import { z } from "zod";

// The docs mark author/minAppVersion/name/version required (plus description/id/isDesktopOnly for
// plugins), but that is aspirational: real, widely-installed plugins ship without minAppVersion or
// author and Obsidian loads them regardless (verified against a live vault — obsidian-git,
// obsidian-mind-map, better-word-count, advanced-uri all omit fields). Gating on the docs' "required"
// reported those as UNREADABLE, defeating the point of detection. So only id/name/version — the
// fields we actually key on (identity + version) — are load-bearing; the rest are optional and fall
// back to "". `fundingUrl` is string | { [label]: url }, a genuine union. Unknown keys pass through.
const ManifestSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.string().min(1),
    minAppVersion: z.string().optional(),
    author: z.string().optional(),
    description: z.string().optional(),
    isDesktopOnly: z.boolean().optional(),
    authorUrl: z.string().optional(),
    fundingUrl: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
  })
  .passthrough();

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion: string;
  author: string;
  description: string;
  isDesktopOnly: boolean;
  /** True when the manifest `id` differs from its containing folder name. Obsidian's installer
   *  names the folder after the id, so a mismatch marks a sideloaded/BRAT/dev install — a warning
   *  worth surfacing, not an error. */
  folderIdMismatch: boolean;
}

export type ManifestResult =
  | { ok: true; plugin: PluginManifest }
  | { ok: false; folder: string; reason: string };

/**
 * Parse one plugin manifest. `folder` is the directory name the manifest was read from — used both
 * for the folder/id mismatch signal and to name the folder in an unreadable result.
 */
export function parseManifest(folder: string, raw: string): ManifestResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { ok: false, folder, reason: `invalid JSON: ${(e as Error).message}` };
  }

  const parsed = ManifestSchema.safeParse(json);
  if (!parsed.success) {
    // Name the offending fields so "unreadable plugin at X" is actionable rather than opaque.
    const fields = parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
    return { ok: false, folder, reason: `invalid manifest (${fields})` };
  }

  const m = parsed.data;
  return {
    ok: true,
    plugin: {
      id: m.id,
      name: m.name,
      version: m.version,
      minAppVersion: m.minAppVersion ?? "",
      author: m.author ?? "",
      description: m.description ?? "",
      isDesktopOnly: m.isDesktopOnly ?? false,
      folderIdMismatch: m.id !== folder,
    },
  };
}
