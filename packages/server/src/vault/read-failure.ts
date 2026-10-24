// The reason a file read failed, safe to show a caller: never the message, which carries the absolute path.

/** The errno code when there is one, else a fixed phrase. */
export function readFailureReason(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === "string" && code !== "" ? code : "read failed";
}
