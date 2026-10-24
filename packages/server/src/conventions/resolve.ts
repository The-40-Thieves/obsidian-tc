// Resolve the conventions that apply to a note: the SCHEMA.md layers on its ancestor chain, each read
// under the CALLER's read ACL, merged nearest-wins per leaf key. The parsed layers are cached on
// their stat signature; the ACL decision is never cached, so a layer a caller may not read is absent
// for that caller whatever another caller has already parsed.
import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { FolderAcl } from "../acl";
import type { RawFolders, WikiFolders } from "../tools/m7/knowledge/wiki-folder";
import { SCHEMA_LIMITS, WIKI_SCHEMA_FILE } from "../tools/m7/knowledge/wiki-schema";
import { MAX_SCAN_WARNINGS } from "../tools/scan-warnings";
import { enforcePathAcl } from "../vault/acl-path";
import { readNoteBounded } from "../vault/notes-io";
import { normalizeVaultPath, resolveVaultPath } from "../vault/paths";
import { readFailureReason } from "../vault/read-failure";
import { LEGACY_HINT, parseConventionsLayer } from "./parse";
import type {
  ConventionsFileWarning,
  ConventionsLayer,
  EffectiveConventions,
  ParsedConventionsLayer,
  SourcedValues,
} from "./schema";

export interface ConventionsScope {
  /** Keys the layer cache: two vaults never share a parsed layer. */
  vaultId: string;
  root: string;
  acl: FolderAcl | undefined;
  grantedScopes: Iterable<string>;
  wikiFolders?: WikiFolders;
  rawFolders?: RawFolders;
}

const LAYER_CACHE_MAX = 512;
const layerCache = new Map<string, { sig: string; parsed: ParsedConventionsLayer }>();

const cacheKey = (vaultId: string, path: string): string => `${vaultId}\u0000${path}`;

/** Drop one vault's cached layer, so the next lookup re-reads it. For a tool that writes a SCHEMA.md. */
export function evictConventionsLayer(vaultId: string, path: string): void {
  let clean: string;
  try {
    clean = normalizeVaultPath(path);
  } catch {
    return; // a path that cannot be normalised was never cached
  }
  layerCache.delete(cacheKey(vaultId, clean));
}

/** True when a regular file sits at this lexical path. Any failure is "no" (absent, not an error). */
function isLexicalFile(abs: string): boolean {
  try {
    return statSync(abs, { throwIfNoEntry: false })?.isFile() === true;
  } catch {
    return false;
  }
}

/** The SCHEMA.md paths that apply to `notePath`, root first, nearest last. */
export function conventionsLayerPaths(notePath: string): string[] {
  let clean: string;
  try {
    clean = normalizeVaultPath(notePath);
  } catch {
    return [];
  }
  const dirs = clean.split("/").slice(0, -1);
  const out = [WIKI_SCHEMA_FILE];
  let dir = "";
  for (const d of dirs) {
    dir = dir === "" ? d : `${dir}/${d}`;
    out.push(`${dir}/${WIKI_SCHEMA_FILE}`);
  }
  return out;
}

const names = (f: WikiFolders | RawFolders): string[] =>
  f === undefined ? [] : typeof f === "string" ? [f] : [...f];

/**
 * Read one layer for this caller: null when it is absent, unreadable under the caller's ACL, or
 * escapes the vault. Otherwise the parsed layer, shared with every caller that reads the same bytes.
 */
export function readConventionsLayer(
  scope: ConventionsScope,
  path: string,
): ParsedConventionsLayer | null {
  // A missing layer is the common case: one lexical stat answers it before any ACL or realpath work.
  // Missing and denied both return null, so this reveals nothing the check below would not.
  if (!isLexicalFile(resolve(scope.root, path))) return null;
  // The ACL is enforced on the REAL path: a layer that is a symlink out of the readable tree is absent.
  try {
    enforcePathAcl(scope.acl, "read", path, scope.root, scope.grantedScopes);
  } catch {
    return null;
  }
  try {
    const abs = resolveVaultPath(scope.root, path);
    const st = statSync(abs, { bigint: true, throwIfNoEntry: false });
    if (!st?.isFile()) return null;
    const sig = `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
    const key = cacheKey(scope.vaultId, path);
    const hit = layerCache.get(key);
    if (hit && hit.sig === sig) {
      layerCache.delete(key);
      layerCache.set(key, hit);
      return hit.parsed;
    }
    const { raw } = readNoteBounded(abs, SCHEMA_LIMITS.fileBytes);
    const parsed: ParsedConventionsLayer =
      raw === null
        ? {
            layer: null,
            warnings: [
              `conventions not read: the file is larger than ${SCHEMA_LIMITS.fileBytes} bytes`,
            ],
            legacyOnly: false,
          }
        : parseConventionsLayer(raw, path);
    layerCache.delete(key);
    if (layerCache.size >= LAYER_CACHE_MAX)
      layerCache.delete(layerCache.keys().next().value as string);
    layerCache.set(key, { sig, parsed });
    return parsed;
  } catch (e) {
    // A refusal says the caller may not see this layer (it leaves what the caller reads, or the vault):
    // absent, with no warning that would reveal that it exists.
    const reason = readFailureReason(e);
    if (reason === "acl_denied" || reason === "path_invalid") return null;
    return {
      layer: null,
      warnings: [`conventions not read: ${reason}`],
      legacyOnly: false,
    };
  }
}

function emptyEffective(scope: ConventionsScope): EffectiveConventions {
  const nullMap = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
  return {
    typeKey: "type",
    typeKeySource: "",
    values: nullMap(),
    types: nullMap(),
    wikiFolders: scope.wikiFolders,
    rawFolders: scope.rawFolders,
    fileWarnings: [],
    fileWarningsOmitted: 0,
    layers: [],
  };
}

/** Keep at most the scan cap of file warnings for one resolve; the rest are counted. */
function pushFileWarning(eff: EffectiveConventions, w: ConventionsFileWarning): void {
  if (eff.fileWarnings.length < MAX_SCAN_WARNINGS) eff.fileWarnings.push(w);
  else eff.fileWarningsOmitted++;
}

/** Set a leaf: a non-empty list replaces what was inherited; an empty one removes it. */
function setLeaf(
  target: Record<string, SourcedValues>,
  key: string,
  values: string[],
  source: string,
) {
  if (values.length === 0) delete target[key];
  else target[key] = { values, source };
}

function mergeLayer(eff: EffectiveConventions, layer: ConventionsLayer): void {
  const source = layer.path;
  if (layer.typeKey !== undefined) {
    eff.typeKey = layer.typeKey;
    eff.typeKeySource = source;
  }
  if (layer.required !== undefined) {
    if (layer.required.length === 0) delete eff.required;
    else eff.required = { values: layer.required, source };
  }
  for (const [prop, values] of Object.entries(layer.values))
    setLeaf(eff.values, prop, values, source);
  for (const [type, rules] of Object.entries(layer.types)) {
    const leaves = Object.keys(rules.values).length > 0 || rules.required !== undefined;
    if (!leaves) continue;
    let target = eff.types[type];
    if (!target) {
      target = { values: Object.create(null) };
      eff.types[type] = target;
    }
    if (rules.required !== undefined) {
      if (rules.required.length === 0) delete target.required;
      else target.required = { values: rules.required, source };
    }
    for (const [prop, values] of Object.entries(rules.values))
      setLeaf(target.values, prop, values, source);
  }
}

/** The merged conventions for a vault-relative note path, as seen by `scope`'s caller. */
export function resolveConventions(
  scope: ConventionsScope,
  notePath: string,
): EffectiveConventions {
  const eff = emptyEffective(scope);
  const wikiFolders = names(scope.wikiFolders);
  const loaded: ConventionsLayer[] = [];
  for (const path of conventionsLayerPaths(notePath)) {
    const read = readConventionsLayer(scope, path);
    if (!read) continue;
    for (const message of read.warnings) pushFileWarning(eff, { path, message });
    eff.fileWarningsOmitted += read.warningsOmitted ?? 0;
    const inWiki = wikiFolders.some((w) => path === (w === "" ? "" : `${w}/`) + WIKI_SCHEMA_FILE);
    if (read.legacyOnly && !inWiki) pushFileWarning(eff, { path, message: LEGACY_HINT });
    if (read.layer) loaded.push(read.layer);
  }
  // A layer with inherit:false cuts off every ancestor above it; the nearest such layer starts the chain.
  let start = 0;
  for (let i = loaded.length - 1; i >= 0; i--)
    if (loaded[i]?.inherit === false) {
      start = i;
      break;
    }
  for (const layer of loaded.slice(start)) {
    mergeLayer(eff, layer);
    eff.layers.push({ path: layer.path, inherit: layer.inherit, version: layer.version });
  }
  if (eff.typeKeySource === "" && loaded.length > 0)
    eff.typeKeySource = loaded[loaded.length - 1]?.path ?? "";
  return eff;
}
