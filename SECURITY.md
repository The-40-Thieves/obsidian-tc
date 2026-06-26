# Security Policy

## Supported versions

obsidian-tc follows semantic versioning. Security fixes land on the latest minor;
older minors are not backported.

| Version | Supported          |
| ------- | ------------------ |
| 1.2.x   | :white_check_mark: |
| < 1.2   | :x:                |

## Reporting a vulnerability

**Do not open public issues for security vulnerabilities.**

Report privately via a GitHub [security advisory](https://github.com/The-40-Thieves/obsidian-tc/security/advisories/new)
on this repository.

Include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix, if known

You'll receive an acknowledgment within 7 days.

## Threat model

obsidian-tc handles vault data, which may include sensitive notes, embedded
credentials, and personal information. The server is designed under the following
assumptions:

- **MCP clients are partially trusted.** JWT auth scopes restrict per-client capabilities.
- **Autonomous agents are partially trusted.** Folder ACLs restrict per-agent read/write
  paths, and human-in-the-loop (HITL) elicit is required on destructive operations.
- **The vault filesystem is trusted.** obsidian-tc does not defend against attacks
  originating from vault content itself (e.g. malicious frontmatter) or against in-vault
  symlinks pointing outside the vault root.
- **The host system is trusted.** obsidian-tc does not protect against attacks from
  co-located processes.

## Protections

- JWT auth (HS256) with a required minimum secret length
- Folder-scoped read / write / delete ACLs per vault
- Read-only kill switch
- HITL elicit on destructive operations (configurable per op)
- Fail-closed config: an unauthenticated HTTP transport refuses to bind a non-loopback host
- Idempotency keys on writes
- Bulk-operation throttling with configurable per-tier limits
- Path-traversal prevention (byte-level rejection of `..` segments and absolute paths)
- Deny-by-default command execution (disabled unless explicitly enabled, allowlisted, and HITL-gated)
- Audit logging of every tool invocation
