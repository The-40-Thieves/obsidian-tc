# Security Policy

## Supported versions

Project is in design phase. No releases yet. Once v1.0 ships, the latest minor will receive security updates.

## Reporting a vulnerability

**Do not open public issues for security vulnerabilities.**

A dedicated security email address will be published before v0.1.0. Until then, contact the maintainer directly via GitHub: open a [private security advisory](https://github.com/The-40-Thieves/obsidian-tc/security/advisories/new).

Include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix, if known

You'll receive acknowledgment within 7 days.

## Threat model (current design)

obsidian-tc handles vault data, which may include sensitive notes, embedded credentials, personal information. The server is designed under the following assumptions:

- **MCP clients are partially trusted.** JWT auth scopes restrict per-client capabilities.
- **Autonomous agents are partially trusted.** Folder ACLs restrict per-agent read/write paths. HITL elicit required on destructive operations.
- **Vault filesystem is fully trusted.** obsidian-tc does not defend against attacks originating from vault content itself (e.g. malicious frontmatter).
- **The host system is fully trusted.** obsidian-tc does not protect against attacks from co-located processes.

## Specific protections

- JWT auth (HS256) with required minimum secret length
- Folder-scoped read/write/delete ACLs per vault
- Read-only kill switch
- HITL elicit on destructive operations (configurable per-op)
- Idempotency keys on writes
- Bulk operation throttling with configurable limits
- Path traversal prevention
- No execution of arbitrary code from vault content
- Audit logging of all tool invocations

Full security architecture lands in G2.4.
