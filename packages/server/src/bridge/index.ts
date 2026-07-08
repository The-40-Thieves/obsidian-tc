// Public surface of the M4 plugin-bridge substrate (THE-180): the typed bridge
// client over an injectable transport, the deterministic fake used by every test,
// the startup auto-probe, the per-vault capability cache + model, and the
// degradation gate that maps absent/unreachable plugins onto the error taxonomy.
export {
  applyOverrides,
  CapabilityCache,
  type CapabilitySnapshot,
  type CompanionState,
  type PluginCapability,
  type PluginOverrides,
  type PluginStatus,
  pluginStatus,
} from "./capabilities";
export { requirePlugin } from "./degrade";
export {
  type FakeBridgeOptions,
  type FakeRequestInfo,
  type FakeRoute,
  fakeBridgeTransport,
} from "./fake";
export {
  buildVaultCapabilities,
  type ProbeOptions,
  probeCompanion,
  type VaultCapabilityOptions,
} from "./probe";
export {
  type BridgeClient,
  type BridgeClientOptions,
  type BridgeFetch,
  type BridgeRequest,
  createBridgeClient,
  DEFAULT_API_PREFIX,
  DEFAULT_BRIDGE_TIMEOUT_MS,
  type NativeResponse,
} from "./transport";
