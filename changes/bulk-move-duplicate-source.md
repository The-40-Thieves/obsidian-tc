---
type: Fixed
---
- **bulk_move_notes refuses a batch that names one source twice.** Two rows with the same `from` (also when spelled `a.md` and `./a.md`) used to both report `ok`, and only the last destination was written. Both rows are now refused with `invalid_input`, nothing moves, and a dry run no longer copies a verdict across them.
