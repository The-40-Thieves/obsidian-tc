import { AclConfigSchema, AclRuleSchema, AuthConfigSchema } from "./config/auth-acl.schema";
import { type GatewayConfig, GatewayConfigSchema } from "./config/gateway.schema";
import {
  EmbeddingsConfigSchema,
  type IndexingConfig,
  IndexingConfigSchema,
} from "./config/indexing-embeddings.schema";
import {
  MaintenanceConfigSchema,
  ObservabilityConfigSchema,
  PlaneConfigSchema,
  PlurConfigSchema,
  SchedulerConfigSchema,
  SnapshotsConfigSchema,
  WatchConfigSchema,
} from "./config/observability.schema";
import { type RerankerConfig, RerankerConfigSchema } from "./config/reranker.schema";
import {
  ExperientialConfigSchema,
  MetadataPriorRuleSchema,
  RankingConfigSchema,
  RetrievalConfigSchema,
} from "./config/retrieval.schema";
import {
  GovernorConfigSchema,
  HttpConfigSchema,
  SessionsConfigSchema,
  type ThrottleConfig,
  ThrottleConfigSchema,
  TransportsConfigSchema,
  WritesConfigSchema,
} from "./config/runtime.schema";
import {
  configJsonSchema,
  type ServerConfig,
  ServerConfigObject,
  ServerConfigSchema,
} from "./config/server.schema";
import {
  type BootstrapConfig,
  BootstrapConfigSchema,
  BootstrapDomainSchema,
  DEFAULT_DEEP_PHRASES,
  ToolFacadeConfigSchema,
  type ToolVisibilityConfig,
  ToolVisibilityConfigSchema,
} from "./config/tools.schema";
import type { VaultConfig, VaultConfigInput, VaultKind } from "./config/vault.schema";
import {
  DEFAULT_MEMORY_FOLDER,
  VaultBridgesConfigSchema,
  VaultCommandsConfigSchema,
  VaultConfigSchema,
  VaultMemoryConfigSchema,
  VaultPluginsConfigSchema,
  VaultWorkspaceConfigSchema,
} from "./config/vault.schema";

export type {
  BootstrapConfig,
  GatewayConfig,
  IndexingConfig,
  RerankerConfig,
  ServerConfig,
  ThrottleConfig,
  ToolVisibilityConfig,
  VaultConfig,
  VaultConfigInput,
  VaultKind,
};
// WP1.1: auth+ACL schemas now live in ./config/auth-acl.schema.ts.
// WP1.2: vault schemas now live in ./config/vault.schema.ts.
// WP1.3: retrieval/ranking/experiential schemas now live in ./config/retrieval.schema.ts.
// WP1.4: embeddings/indexing schemas now live in ./config/indexing-embeddings.schema.ts.
// WP1.5: http/transports/governor/throttle/writes schemas now live in ./config/runtime.schema.ts.
// WP1.6: observability/snapshots/maintenance/watch/scheduler/plane/plur schemas now live in
// ./config/observability.schema.ts.
// WP1.7: tool-visibility/tool-facade/bootstrap schemas now live in ./config/tools.schema.ts.
// WP1.8: the top-level ServerConfigObject/ServerConfigSchema composition, the cross-domain
// http/auth interlock, and configJsonSchema() now live in ./config/server.schema.ts — the
// composition point that imports all seven sibling leaves above. This file is now a pure
// re-export facade: every existing import of these names keeps working, but nothing is defined
// here anymore.
export {
  AclConfigSchema,
  AclRuleSchema,
  AuthConfigSchema,
  BootstrapConfigSchema,
  BootstrapDomainSchema,
  configJsonSchema,
  DEFAULT_DEEP_PHRASES,
  DEFAULT_MEMORY_FOLDER,
  EmbeddingsConfigSchema,
  ExperientialConfigSchema,
  GatewayConfigSchema,
  GovernorConfigSchema,
  HttpConfigSchema,
  IndexingConfigSchema,
  MaintenanceConfigSchema,
  MetadataPriorRuleSchema,
  ObservabilityConfigSchema,
  PlaneConfigSchema,
  PlurConfigSchema,
  RankingConfigSchema,
  RerankerConfigSchema,
  RetrievalConfigSchema,
  SchedulerConfigSchema,
  ServerConfigObject,
  ServerConfigSchema,
  SessionsConfigSchema,
  SnapshotsConfigSchema,
  ThrottleConfigSchema,
  ToolFacadeConfigSchema,
  ToolVisibilityConfigSchema,
  TransportsConfigSchema,
  VaultBridgesConfigSchema,
  VaultCommandsConfigSchema,
  VaultConfigSchema,
  VaultMemoryConfigSchema,
  VaultPluginsConfigSchema,
  VaultWorkspaceConfigSchema,
  WatchConfigSchema,
  WritesConfigSchema,
};
