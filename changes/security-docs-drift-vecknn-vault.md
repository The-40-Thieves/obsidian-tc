---
type: Fixed
---
- **vecKnn requires a vault id.** The search helper no longer has an unscoped mode that ranks every vault's vectors. Internal callers already pass the vault, so no config or tool change is needed.
- **Security and architecture docs match the code.** SECURITY.md now states the fixed HITL floors, the ACL-rebuild-on-restart rule, the replayable `requestState` window and the bridge-tool boundary. ARCHITECTURE.md and TREE.md list the 2026-07-28 MCP surface, the `oidc` auth mode and the shipped native exports. config-yaml documents `retention.tracesDays` (default 30).
