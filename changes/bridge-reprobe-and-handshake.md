---
type: Fixed
---
- **The server now notices companion changes after boot, and reports a companion on a different version.** A vault whose companion answered at boot was never probed again, so a community plugin enabled later stayed unavailable and a closed Obsidian still read as reachable until `refresh_plugin_capabilities` was run by hand. The background re-probe now also re-checks reachable vaults every 10 minutes (unreachable vaults keep the 60-second cadence). The version handshake now compares the companion's version with the server's: a difference keeps the bridge live but logs one warning at boot, and `doctor` reports the vault as `version-mismatch` with a warning. A new test holds the plugin's bridge API version and the server's two copies of it equal.
