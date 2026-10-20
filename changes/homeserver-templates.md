---
type: Added
---
- **Home-server templates for Umbrel, CasaOS / ZimaOS and Unraid.** `deploy/homeserver/` holds an Umbrel
  community app, a CasaOS compose app and an Unraid template. Each runs the published image on a LAN with
  a bearer token, an exact allow-list of hosts and a vault folder you pick. The JWT secret is never a
  literal value: Umbrel derives it per install, and CasaOS and Unraid ask for it at install. See the
  Home server page in the deployment docs.
