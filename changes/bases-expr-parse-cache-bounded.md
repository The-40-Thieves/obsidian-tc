---
type: Security
---
- **Bounded the Bases expression parse cache.** `query_base` retained every distinct filter or formula expression for the life of the process, so a caller with read access to bases could grow server memory without limit by sending unique expressions. Expressions longer than 16,384 characters are now refused with `unsupported_base_filter` before parsing, and the parse cache holds at most 128 entries and 262,144 source characters, evicting the least recently used first. Existing `.base` files and valid expressions behave as before.
