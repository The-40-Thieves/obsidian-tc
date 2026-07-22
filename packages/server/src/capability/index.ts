// THE-522 — environment/capability detection. Reads the machine (Obsidian install, vaults, plugins,
// runtime, hardware) into a typed profile that doctor (THE-521), install presets (THE-509) and CI
// consume. Every reader degrades rather than throws; "no Obsidian" is a first-class state.

export type {
  ConfigDirResult,
  DiscoveredPlugin,
  PluginDiscovery,
  RegistryVault,
} from "./discovery";
export {
  discoverPlugins,
  parseRegistry,
  resolveConfigDir,
} from "./discovery";
export type { Gpu, HardwareEnrichment, HardwareEnvelope } from "./hardware";
export { hardwareEnvelope } from "./hardware";
export { locateRegistry, registryCandidates } from "./locate";
export type { ManifestResult, PluginManifest } from "./manifest";
export { parseManifest } from "./manifest";
export type {
  CapabilityProfile,
  ResolveOptions,
  RuntimeProfile,
  VaultProfile,
} from "./profile";
export { resolveCapabilityProfile } from "./profile";
