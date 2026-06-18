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
 * Repoint every link to a moved attachment, fenced-code aware. A bare-basename link
 * is rewritten to the new basename; a path link to the new vault-relative path, so
 * the link style is preserved. Returns the count of notes and links rewritten.
 */
export function rewriteAttachmentReferences(
  root: string,
  fromRel: string,
  toRel: string,
): { notes: number; refs: number } {
  const fromPath = fromRel.toLowerCase();
  const fromBase = baseOf(fromRel).toLowerCase();
  const toBase = baseOf(toRel);
  let notes = 0;
  let refs = 0;
  for (const e of walkVault(root, { extensions: [".md"] })) {
    const abs = resolveVaultPath(root, e.relPath);
    const { raw } = readNote(abs);
    const { text, count } = rewriteLinks(raw, (targetRaw) => {
      const t = normalizeTarget(targetRaw);
      if (t === "") return null;
      const hadSlash = t.includes("/");
      const lb = hadSlash ? t.slice(t.lastIndexOf("/") + 1) : t;
      if (t === fromPath) return hadSlash ? toRel : toBase;
      if (lb === fromBase) return hadSlash ? toRel : toBase;
      return null;
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
