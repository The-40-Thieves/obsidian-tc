---
type: Security
config-schema-change: auth.as.dynamicRegistration
---
- **Dynamic Client Registration is now opt-in everywhere.** Set `auth.as.dynamicRegistration: true` only for clients that require it; unset now means no registration endpoint or boot notice. Registration is not an endorsement. `auth as clients list|remove` manages DCR registrations without exposing secrets; removal ends pending sign-ins and revokes all the client's grants and tokens, even with DCR disabled. Static and metadata-document clients cannot be removed this way, and revoked grants no longer suppress the unapproved-client warning. Empty or `offline_access`-only scope requests keep the configured default (otherwise `read:*`) but always require full consent. Mixed unsupported scopes are dropped and listed on the consent page, never granted. Existing pending sign-ins are discarded on upgrade because their scope provenance was not recorded; start those sign-ins again.
