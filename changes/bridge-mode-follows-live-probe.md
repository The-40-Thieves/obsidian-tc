---
type: Fixed
---
- **A companion that was unreachable at startup is picked up without a restart.** The Tier-3 live gate used to be fixed at the boot probe, so a vault whose companion answered only after startup kept refusing Dataview, Tasks, Templater, Git and the other companion tools until a manual `refresh_plugin_capabilities`, and even that refresh left the gate closed. The gate now follows the live capability snapshot, and the server re-probes any bridged vault whose companion is unreachable or missing once a minute until it answers. A failed boot probe is logged with its cause code.
