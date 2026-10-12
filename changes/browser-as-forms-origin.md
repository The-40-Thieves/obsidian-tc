---
type: Fixed
---
- **Bundled authorization-server sign-in and consent forms are no longer refused by browsers.** Their referrer policy is now `same-origin`, so same-origin POSTs carry the real `Origin` required by the server's CSRF check while cross-origin redirects still disclose no referrer. The previous `no-referrer` policy made browsers serialize the POST origin as `null`, causing login, setup, consent, logout, and passkey forms to answer “Request refused”.
