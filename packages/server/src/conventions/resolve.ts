// Resolve the conventions that apply to a note: the SCHEMA.md layers on its ancestor chain, each read
// under the CALLER's read ACL, merged nearest-wins per leaf key. The parsed layers are cached on
// their stat signature; the ACL decision is never cached, so a layer a caller may not read is absent
// for that caller whatever another caller has already parsed.
import { statSync } from "node:fs";
import type { FolderAcl } from "../acl";
import type { RawFolders, WikiFolders } from "../tools/m7/knowledge/wiki-folder";
import { SCHEMA_LIMITS, WIKI_SCHEMA_FILE } from "../tools/m7/knowledge/wiki-schema";
import { enforcePathAcl } from "../vault/acl-path";
import { readableRel } from "../vault/acl-read-filter";
import { readNoteBounded } from "../vault/notes-io";
import { normalizeVaultPath, resolveVaultPath } from "../vault/paths";
import { LEGACY_HINT, parseConventionsLayer } from "./parse";
import type {
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
  layerCache.delete(cacheKey(vaultId, path));
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
  if (!readableRel(scope.acl, path, scope.grantedScopes)) return null;
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
    return {
      layer: null,
      warnings: [`conventions not read: ${e instanceof Error ? e.message : String(e)}`],
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
  };
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
    for (const message of read.warnings) eff.fileWarnings.push({ path, message });
    const inWiki = wikiFolders.some((w) => path === (w === "" ? "" : `${w}/`) + WIKI_SCHEMA_FILE);
    if (read.legacyOnly && !inWiki) eff.fileWarnings.push({ path, message: LEGACY_HINT });
    if (read.layer) loaded.push(read.layer);
  }
  // A layer with inherit:false cuts off every ancestor above it; the nearest such layer starts the chain.
  let start = 0;
  for (let i = loaded.length - 1; i >= 0; i--)
    if (loaded[i]?.inherit === false) {
      start = i;
      break;
    }
  for (const layer of loaded.slice(start)) mergeLayer(eff, layer);
  if (eff.typeKeySource === "" && loaded.length > 0)
    eff.typeKeySource = loaded[loaded.length - 1]?.path ?? "";
  return eff;
}
