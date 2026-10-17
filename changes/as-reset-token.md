---
type: Added
---
- **Operator password reset without a shell.** On a host with no terminal, set `OBSIDIAN_TC_AS_RESET_TOKEN` (or the name in `auth.as.resetTokenEnv`) to a random value of at least 24 characters, restart, and open `<issuer>/oauth/setup` to choose a new operator password. The token works once and is refused after that; the boot window closes 24 hours after start. Remove the variable afterwards: the server warns at every boot while it is set. Revoking every grant from the page is an option, refused while the revocation registry is lost.
