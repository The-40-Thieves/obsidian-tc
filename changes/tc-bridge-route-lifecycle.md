---
type: Fixed
---
- **TC Bridge now releases its routes when it unloads and re-attaches them when Local REST API loads.** Before, disabling, reloading or updating TC Bridge without restarting Obsidian left the previous build's routes mounted in front of the new ones, so the old code kept answering and `/probe` kept reporting the old version. TC Bridge now calls Local REST API's `unregister()` from `onunload`, clears a registration an older build left behind when it loads, and registers again on Local REST API's `obsidian-local-rest-api:loaded` event, so a Local REST API that loads after TC Bridge (or reloads) no longer leaves the bridge without routes. Nothing to configure; updating the plugin is enough.
