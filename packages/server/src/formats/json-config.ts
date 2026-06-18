// JSON config-file IO with round-trip fidelity. Obsidian (and its plugins) write
// .obsidian/*.json with their own keys and indentation; M3 tools must never drop
// or reorder keys they do not model. The pattern everywhere in M3: JSON.parse to a
// raw object (preserving on-disk key order), mutate only the modeled keys in place,
// then re-serialize with the file's original indentation. A missing file yields a
// caller-supplied empty default; a malformed file throws invalid_input.
import { existsSync, readFileSync } from "node:fs";
import { err } from "@obsidian-tc/shared";
import { writeNoteAtomic } from "../vault/notes-io";
import { contentHash } from "../vault/paths";

export interface JsonFile<T = Record<string, unknown>> {
  exists: boolean;
  data: T;
  indent: string | number;
  trailingNewline: boolean;
  hash: string | null;
}

/** Sniff the indentation of a JSON document (tab or N spaces); defaults to tab. */
export function detectJsonIndent(raw: string): string | number {
  const m = raw.match(/\n([ \t]+)\S/);
  if (!m) return "\t";
  const ws = m[1] ?? "\t";
  return ws.includes("\t") ? "\t" : ws.length;
}

/**
 * Parse a JSON config file. A missing file returns exists:false with the supplied
 * empty default (so callers can treat "no bookmarks.json yet" as "no bookmarks").
 * Malformed JSON, or a non-object root, throws invalid_input.
 */
export function readJsonFile<T = Record<string, unknown>>(abs: string, empty: T): JsonFile<T> {
  if (!existsSync(abs))
    return { exists: false, data: empty, indent: "\t", trailingNewline: true, hash: null };
  const raw = readFileSync(abs, "utf8");
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw err.invalidInput("file is not valid JSON");
  }
  if (data === null || typeof data !== "object" || Array.isArray(data))
    throw err.invalidInput("JSON config root must be an object");
  return {
    exists: true,
    data: data as T,
    indent: detectJsonIndent(raw),
    trailingNewline: raw.endsWith("\n"),
    hash: contentHash(raw),
  };
}

/** Serialize a JSON value with the given indentation and optional trailing newline. */
export function serializeJson(
  data: unknown,
  indent: string | number = "\t",
  trailingNewline = true,
): string {
  return JSON.stringify(data, null, indent) + (trailingNewline ? "\n" : "");
}

/** Atomically write a JSON value; returns the serialized content and its hash. */
export function writeJsonFile(
  abs: string,
  data: unknown,
  indent: string | number = "\t",
  trailingNewline = true,
): { content: string; hash: string } {
  const content = serializeJson(data, indent, trailingNewline);
  writeNoteAtomic(abs, content, true);
  return { content, hash: contentHash(content) };
}
