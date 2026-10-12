---
type: Fixed
---
- **Preserved trailing newlines when patching the final section.** The `append` and `replace` operations on the last section of a note that ends with a newline no longer add a stray blank line or drop the final newline, and `lines_removed` no longer counts the phantom line after it. `replace_text` behaves as before.
