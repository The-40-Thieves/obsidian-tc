// Re-export shim. "Where a wiki page may live" split in two for subsystem layering
// (no-conventions-imports-high / no-low-layer-imports-high): the spelling-level layout contract
// (the folder's names, its generated pages, the raw-sources filter) moved to
// conventions/wiki-layout.ts, and the filesystem identity half (what a configured folder resolves
// to through symlinks and inodes) moved to vault/wiki-folders.ts. Everything this module exported
// still imports from here unchanged.
export {
  isGeneratedWikiPath,
  pathInFolder,
  type RawFolders,
  rawPathFilter,
  WIKI_INDEX_FILE,
  WIKI_LOG_FILE,
  type WikiFolders,
} from "../../../conventions/wiki-layout";
export {
  assertWikiPagePath,
  foldersShareDirectory,
  insideFolder,
  type RawFolderPlacement,
  rawFolderNames,
  rawFolderPlacement,
  wikiFolderNames,
} from "../../../vault/wiki-folders";
