// Attachment helpers. Resolves the vault's attachment folder (Obsidian core
// app.json -> attachmentFolderPath), classifies common attachment extensions and
// their MIME types, and counts/locates/rewrites note references to an attachment so
// move/delete can update links or gate on reference count. Pure filesystem; no
// plugin. Reference detection reuses the M1 link extractor + rewriter and matches a
// link to an attachment by exact vault-relative path or by basename (Obsidian's
// shortest-path attachment resolution).
import { join } from "node:path";
import { err, type VaultMemoryDefenseConfig } from "@the-40-thieves/obsidian-tc-shared";
import type { MetricsRecorder } from "../metrics/registry";
import type { ImmutableRewriteSkips } from "../vault/acl-path";
import { parseNoteLenient } from "../vault/frontmatter";
import { extractNoteLinks } from "../vault/links";
import { type PlannedRewrite, plannedRewrite, RewriteScan } from "../vault/move-plan";
import { readNote } from "../vault/notes-io";
import { normalizeVaultPath, resolveVaultPath, walkVault } from "../vault/paths";

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

function baseOf(rel: string): string {
  return rel.includes("/") ? rel.slice(rel.lastIndexOf("/") + 1) : rel;
}

/** Lowercased extension of the last path SEGMENT. Taken from the segment, not the whole path: a
 *  dot in a folder name (`a.png/readme`) must not read as the file's extension. */
export function extOf(rel: string): string {
  // Cut at the first `:` too: on NTFS everything after it names a stream OF the file before it, so
  // `report.md:.png` is a `.md` file, never a `.png` one.
  const base = baseOf(rel).split(":")[0] ?? "";
  const i = base.lastIndexOf(".");
  return i < 0 ? "" : base.slice(i).toLowerCase();
}

/** MIME type for an attachment path, or application/octet-stream when unknown. */
export function mimeOf(rel: string): string {
  return MIME[extOf(rel)] ?? "application/octet-stream";
}

/** Resolve the configured attachment folder (Obsidian app.json), or "" (vault root). */
export function resolveAttachmentFolder(root: string): string {
  try {
    const app = JSON.parse(readNote(join(root, ".obsidian", "app.json")).raw) as Record<
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
    // A property link counts (`cover: "[[img.png]]"`): an image used only there is still referenced.
    // Lenient: a note whose YAML does not parse still has its body links counted.
    const note = parseNoteLenient(readNote(resolveVaultPath(root, e.relPath)).raw, e.relPath);
    const hit = extractNoteLinks(note).some((l) => {
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

/** The new body of every note that references a moved attachment: proven, memoryDefense-scanned, and
 *  not yet written. Each carries its pre-image, which the commit batch re-checks. */
export interface AttachmentReferencePlan {
  pending: PlannedRewrite[];
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
 * Resolution uses the PRE-move attachment set. It works from the vault on either side of the move:
 * a toRel entry already on disk is mapped back to fromRel, and fromRel is always seeded even when
 * no attachment file is on disk (e.g. a link to an attachment that was never materialized).
 *
 * Planning and writing are separate: `planAttachmentReferences` computes and proves every new body
 * (it only reads), so move_attachment runs it BEFORE the move and a link that cannot be written
 * refuses the whole move; move_attachment then writes the plan as one write batch.
 *
 * Review finding: the rewritten link text lands in an ordinary note BODY (not the binary
 * attachment), so it gets the same memoryDefense scan every other note-content writer applies.
 * The scan runs in the PLAN (`defense`; block -> the whole rewrite is refused before anything
 * moves, redact -> every write lands in its redacted form).
 */
// ACL carve-out: this rewrites links in EVERY referencing note to keep links valid,
// including notes outside the caller's write whitelist. Deliberate graph-integrity
// invariant (a constrained link-text update, not arbitrary write access) — audit #12.
export function planAttachmentReferences(
  root: string,
  fromRel: string,
  toRel: string,
  skips: ImmutableRewriteSkips,
  defense: VaultMemoryDefenseConfig | undefined,
  metrics: MetricsRecorder | undefined,
): AttachmentReferencePlan {
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

  const pending: PlannedRewrite[] = [];
  const scan = new RewriteScan(skips);
  for (const e of walkVault(root, { extensions: [".md"] })) {
    const abs = resolveVaultPath(root, e.relPath);
    const note = scan.read(abs, e.relPath);
    if (!note) continue;
    const { raw } = note;
    const rewrite = scan.note(
      raw,
      (targetRaw) => {
        const t = normalizeTarget(targetRaw);
        if (t === "") return null;
        const hadSlash = t.includes("/");
        if (!resolvesToFrom(t, hadSlash)) return null;
        return hadSlash ? toRel : toBaseUnique ? toBase : toRel;
      },
      e.relPath,
    );
    if (rewrite && rewrite.count > 0)
      pending.push(plannedRewrite(abs, e.relPath, raw, rewrite, defense, metrics));
  }
  scan.refuseIfFailed();
  return { pending };
}

/** Whether a vault-relative path has a recognized attachment extension. */
export function isAttachment(rel: string, extensions?: string[]): boolean {
  const exts = (extensions ?? DEFAULT_ATTACHMENT_EXTS).map((x) => x.toLowerCase());
  const e = extOf(rel);
  return e !== "" && exts.includes(e);
}

/** True for a bare filename (no folder, no explicit leading `./`): the only input whose real
 *  destination depends on the vault's configured attachment folder, which only the root can say. */
export function isBareAttachmentName(raw: string): boolean {
  const rel = normalizeVaultPath(raw);
  return !(rel.includes("/") || /^\.[\\/]/.test(raw));
}

/** Where write_attachment puts `raw`: a bare filename goes into the vault's configured attachment
 *  folder (Obsidian's own default for a pasted file), a path with a folder is used as given, and a
 *  leading `./` says "the vault root" explicitly. Returns the normalized vault-relative path. */
export function resolveAttachmentWritePath(root: string, raw: string): string {
  const rel = normalizeVaultPath(raw);
  if (!isBareAttachmentName(raw)) return rel;
  const folder = resolveAttachmentFolder(root);
  return folder ? normalizeVaultPath(`${folder}/${rel}`) : rel;
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Strictly validate a standard-alphabet, padded base64 payload and return its decoded size, without
 * decoding it. The size cap is checked from the string length first (O(1)), so an oversized payload
 * is refused before it is scanned, let alone allocated. Rejects what Buffer.from(_, "base64") would
 * silently accept: whitespace, the URL-safe alphabet, missing padding, junk characters, and non-zero
 * trailing bits (a non-canonical encoding). A `data:` URI is refused rather than parsed.
 */
export function checkBase64Payload(content: string, maxBytes: number): number {
  if (content.startsWith("data:"))
    throw err.invalidInput("data: URIs are not accepted; send the raw base64 payload", {
      reason: "data_uri",
    });
  const len = content.length;
  // The longest padded base64 string that can decode to <= maxBytes.
  if (len > Math.ceil(maxBytes / 3) * 4)
    throw err.invalidInput("attachment payload exceeds the configured size cap", {
      max_bytes: maxBytes,
      base64_chars: len,
    });
  if (len % 4 !== 0)
    throw err.invalidInput("content is not valid base64 (length is not a multiple of 4)", {
      reason: "length",
    });
  const pad = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
  const decoded = (len / 4) * 3 - pad;
  if (decoded > maxBytes)
    throw err.invalidInput("attachment payload exceeds the configured size cap", {
      max_bytes: maxBytes,
      size: decoded,
    });
  if (!BASE64_RE.test(content))
    throw err.invalidInput("content is not valid base64 (standard alphabet, padded)", {
      reason: "alphabet",
    });
  if (pad > 0) {
    const last = BASE64_ALPHABET.indexOf(content[len - pad - 1] as string);
    if ((last & (pad === 2 ? 15 : 3)) !== 0)
      throw err.invalidInput("content is not canonical base64 (non-zero trailing bits)", {
        reason: "trailing_bits",
      });
  }
  return decoded;
}
