// The `mode` refusals shared by write_note and bulk_create_notes. They name the parameter and its
// values: "use overwrite" read as a boolean flag, and clients sent `overwrite: true`, an
// unrecognized key.
import { err, type ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";

export function createModeConflictError(path: string): ObsidianTcError {
  return err.noteExists(
    'note already exists; set mode: "overwrite" (replaces it, asks for confirmation) or mode: "upsert", or use append_note to add to it',
    { path },
  );
}

export function overwriteModeMissingError(path: string): ObsidianTcError {
  return err.noteNotFound('note does not exist; set mode: "create" or mode: "upsert"', { path });
}
