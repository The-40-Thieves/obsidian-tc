// THE-1124 — render an ImportReport as the CLI's stdout table. Pure string formatting, no I/O,
// so it is trivially snapshot-testable and independent of dry-run vs --apply (the report already
// carries `applied`; this only decides how to word it).
import type { EntityOutcome, ImportReport } from "./apply";

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function table(rows: string[][], headers: string[]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]): string =>
    cells
      .map((c, i) => pad(c, widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

function entityRow(e: EntityOutcome): string[] {
  const detail =
    e.action === "create"
      ? `+${e.observationsToAdd} observation(s)`
      : e.action === "exists" || e.action === "resumed"
        ? `+${e.observationsToAdd} new, ${e.observationsAlready} already present`
        : (e.reason ?? "");
  return [e.action, e.entityType, e.name, e.sourcePath, detail];
}

export function formatImportReport(report: ImportReport): string {
  const lines: string[] = [];
  const mode = report.applied
    ? "APPLY (writes were made)"
    : "DRY RUN (nothing was written; pass --apply to write)";
  lines.push(`obsidian-tc memory import --from ${report.adapter}: ${mode}`, "");

  if (report.entities.length > 0) {
    lines.push(
      "Entities:",
      table(report.entities.map(entityRow), [
        "action",
        "type",
        "name",
        "source_path",
        "observations",
      ]),
      "",
    );
  } else {
    lines.push("Entities: none found", "");
  }

  const relationRows: string[][] = [];
  for (const e of report.entities) {
    for (const r of e.relations) {
      relationRows.push([e.name, r.relationType, r.targetName, r.status, r.reason ?? ""]);
    }
  }
  if (relationRows.length > 0) {
    lines.push(
      "Relations:",
      table(relationRows, ["source", "relation_type", "target", "status", "reason"]),
      "",
    );
  }

  const created = report.entities.filter((e) => e.action === "create").length;
  const existing = report.entities.filter((e) => e.action === "exists").length;
  const resumed = report.entities.filter((e) => e.action === "resumed").length;
  const collisions = report.entities.filter((e) => e.action === "collision");
  const errors = report.entities.filter((e) => e.action === "error");
  const obsToAdd = report.entities.reduce((n, e) => n + e.observationsToAdd, 0);
  const obsAlready = report.entities.reduce((n, e) => n + e.observationsAlready, 0);
  const relCreated = relationRows.filter((r) => r[3] === "created" || r[3] === "planned").length;
  const relAlready = relationRows.filter((r) => r[3] === "already-exists").length;
  const relSkipped = relationRows.filter((r) => r[3] === "skipped").length;

  lines.push(
    `Summary: ${created} entity(ies) to create, ${existing} already present, ` +
      `${resumed} resumed, ${collisions.length} collision(s), ${errors.length} error(s); ` +
      `${obsToAdd} observation(s) to add, ${obsAlready} already present; ` +
      `${relCreated} relation(s) to create, ${relAlready} already present, ${relSkipped} skipped`,
  );

  if (report.skipped.length > 0) {
    lines.push(
      "",
      "Skipped files:",
      table(
        report.skipped.map((s) => [s.sourcePath, s.reason]),
        ["source_path", "reason"],
      ),
    );
  }

  return lines.join("\n");
}
