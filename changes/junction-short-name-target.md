---
type: Fixed
---
- **A Windows junction whose target is spelled with an 8.3 short name no longer reads as leaving the vault.** The vault root is registered through the native realpath, which expands a short name such as `RUNNER~1`, while paths inside the vault were resolved with the JS realpath, which returns a junction's target as it was written. A junction that stays inside the vault was therefore refused with `path_invalid` ("path escapes the vault root") instead of being judged by its real location: a denied target was not reported as `acl_denied`, and an allowed one could not be reached. The containment check and the configured-folder pins now resolve the same way the root does. Nothing that was refused before for genuinely leaving the vault is accepted now.
