---
type: Fixed
---
- **The bundled authorization server no longer refuses or truncates a large OAuth `state`.** `GET /oauth/authorize` capped `state` at 512 bytes, which RFC 6749 does not bound at all, and the error redirect echoed a 512-byte *prefix* of whatever the client sent. Clients whose `state` is a signed-and-encrypted blob — Google's Gemini among them — could never connect: the prefix failed inside their own crypto (`Ciphertext HMAC does not verify`) and hid the OAuth error the redirect was reporting. The bound is now 4096 bytes as a DoS floor only, and `state` is echoed byte for byte or omitted, never shortened.
