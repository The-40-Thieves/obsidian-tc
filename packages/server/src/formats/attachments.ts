// Attachment helpers. Resolves the vault's attachment folder (Obsidian core
// app.json -> attachmentFolderPath), classifies common attachment extensions and
// their MIME types, and counts/locates/rewrites note references to an attachment so
// move/delete can update links or gate on reference count. Pure filesystem; no
// plugin. Reference detection reuses the M1 link extractor + rewriter and matches a
// link to an attachment by exact vault-relative path or by basename (Obsidian's
// shortest-path attachment resolution).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseNote } from "../vault/frontmatter";
import { extractLinks } from "../vault/links";
import { readNote, writeNoteAtomic } from "../vault/notes-io";
import { resolveVaultPath, walkVault } from "../vault/paths";
import { rewriteLinks } from "../vault/rewrite";

export const DEFAULT_ATTACHMENT_EXTS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
  ".avif",
  ".pdf",
  ".mp3",
  ".wav",
  ".m4a",
  ".ogg",
  ".flac",
  ".3gp",
  ".mp4",
  ".mov",
  ".webm",
  ".mkv",
  ".ogv",
];

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".3gp": "audio/3gpp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".ogv": "video/ogg",
};

function extOf(rel: string): string {
  const i = rel.lastIndexOf(".");
  return i < 0 ? "" : rel.slice(i).toLowerCase();
}

function baseOf(rel: string): string {
  return rel.includes("/") ? rel.slice(rel.lastIndexOf("/") + 1) : rel;
}

/** MIME type for an attachment path, or application/octet-stream when unknown. */
export function mimeOf(rel: string): string {
  return MIME[extOf(rel)] ?? "application/octet-stream";
}

/** Resolve the configured attachment folder (Obsidian app.json), or "" (vault root). */
export function resolveAttachmentFolder(root: string): string {
  try {
    const app = JSON.parse(readFileSync(join(root, ".obsidian", "app.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const p = app.attachmentFolderPath;
    // "" (root) and "./" (note-relative) both mean "no single fixed folder"; only an
    // in-vault folder value is a fixed root we can list against.
    if (typeof p === "string" && p && p !== "/" && !p.startsWith("./")) return p.replace(/^\//, "");
  } catch {
    /* missing/malformed app.json -> default to vault root */
  }
  return "";
}

function normalizeTarget(targetRaw: string): string {
  let t = targetRaw.replace(/\\/g, "/");
  try {
    t = decodeURIComponent(t);
  } catch {
    /* leave malformed percent-encoding as-is */
  }
  return t.replace(/^\.\//, "").trim().toLowerCase();
}

/** List the vault-relative paths of every note that references an attachment. */
export function findAttachmentReferences(root: string, attachmentRel: string): string[] {
  const targetPath = attachmentRel.toLowerCase();
  const targetBase = baseOf(attachmentRel).toLowerCase();
  const out: string[] = [];
  for (const e of walkVault(root, { extensions: [".md"] })) {
    const { body } = parseNote(readNote(resolveVaultPath(root, e.relPath)).raw);
    const hit = extractLinks(body).some((l) => {
      if (l.inCodeblock) return false;
      const t = normalizeTarget(l.target);
      if (t === "") return false;
      if (t === targetPath) return true;
      const lb = t.includes("/") ? t.slice(t.lastIndexOf("/") + 1) : t;
      return lb === targetBase;
    });
    if (hit) out.push(e.relPath);
  }
  return out;
}

/**
 * Repoint every link that RESOLVES to a moved attachment, fenced-code aware. A
 * path-style link is rewritten only when its vault-relative path matches the moved
 * file exactly; a bare-basename link only when the moved file is the one that
 * basename resolves to under Obsidian rules (unique basename, or shortest-path
 * winner on a collision). This avoids corrupting a same-basename link that points
 * at a DIFFERENT file in another folder. Link style is preserved (bare -> new
 * basename, path -> new vault-relative path). Returns notes/links rewritten.
 *
 * Resolution uses the PRE-move attachment set: the caller relocates the file
 * (fromRel -> toRel) before calling this, so the current toRel entry is mapped back
 * to fromRel, and fromRel is always seeded even when no attachment file is on disk
 * (e.g. a link to an attachment that was never materialized).
 */
export function rewriteAttachmentReferences(
  root: string,
  fromRel: string,
  toRel: string,
): { notes: number; refs: number } {
  const fromPathLower = fromRel.toLowerCase();
  const toBase = baseOf(toRel);
  const preSet = new Set(
    walkVault(root, { extensions: DEFAULT_ATTACHMENT_EXTS })
      .map((e) => e.relPath)
      .map((p) => (p === toRel ? fromRel : p)),
  );
  preSet.add(fromRel);
  const byBase = new Map<string, string[]>();
  for (const p of preSet) {
    const b = baseOf(p).toLowerCase();
    const list = byBase.get(b);
    if (list) list.push(p);
    else byBase.set(b, [p]);
  }

  // Post-move basename uniqueness for the OUTPUT form. preSet is the PRE-move set
  // (toRel mapped back to fromRel); mapping fromRel forward to toRel yields the
  // post-move set. A bare-basename link may only be emitted as a bare basename when
  // that basename is unique post-move; otherwise it must be the full vault-relative
  // path, or it would resolve to a DIFFERENT same-name attachment in another folder.
  const toBaseLower = toBase.toLowerCase();
  let toBaseCountPost = 0;
  for (const p of preSet) {
    const post = p === fromRel ? toRel : p;
    if (baseOf(post).toLowerCase() === toBaseLower) toBaseCountPost++;
  }
  const toBaseUnique = toBaseCountPost <= 1;

  /** Does a normalized, lowercased link target resolve to fromRel? */
  const resolvesToFrom = (t: string, hadSlash: boolean): boolean => {
    if (hadSlash) return t === fromPathLower; // path link: exact vault-relative path only
    const candidates = byBase.get(t);
    if (!candidates || candidates.length === 0) return false;
    if (candidates.length === 1) return candidates[0]?.toLowerCase() === fromPathLower;
    // Collision: Obsidian's shortest-path winner (fewest segments, then lexicographic).
    const winner = [...candidates].sort((a, b) => {
      const da = a.split("/").length;
      const db = b.split("/").length;
      return da !== db ? da - db : a.localeCompare(b);
    })[0];
    return winner?.toLowerCase() === fromPathLower;
  };

  let notes = 0;
  let refs = 0;
  for (const e of walkVault(root, { extensions: [".md"] })) {
    const abs = resolveVaultPath(root, e.relPath);
    const { raw } = readNote(abs);
    const { text, count } = rewriteLinks(raw, (targetRaw) => {
      const t = normalizeTarget(targetRaw);
      if (t === "") return null;
      const hadSlash = t.includes("/");
      if (!resolvesToFrom(t, hadSlash)) return null;
      return hadSlash ? toRel : toBaseUnique ? toBase : toRel;
    });
    if (count > 0) {
      writeNoteAtomic(abs, text, false);
      notes++;
      refs += count;
    }
  }
  return { notes, refs };
}

/** Whether a vault-relative path has a recognized attachment extension. */
export function isAttachment(rel: string, extensions?: string[]): boolean {
  const exts = (extensions ?? DEFAULT_ATTACHMENT_EXTS).map((x) => x.toLowerCase());
  const e = extOf(rel);
  return e !== "" && exts.includes(e);
}
