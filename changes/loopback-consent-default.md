---
type: Security
config-schema-change: auth.as.consent.loopback
---
- **Loopback OAuth sign-ins now ask for consent by default**, even for a previously approved client on the same port. A second local process claiming that client's public identity cannot silently reuse its approval. Set `auth.as.consent.loopback: remember` explicitly to retain silent native-CLI sign-ins, accepting that approvals are shared across local processes and ports. Existing grants and non-loopback consent behavior are unchanged.
