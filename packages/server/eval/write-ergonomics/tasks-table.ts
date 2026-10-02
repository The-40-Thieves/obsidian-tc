// Render the task list as a markdown table (for PREREGISTRATION.md and the README), so the frozen
// document is generated from the code that runs rather than retyped.
import { TASKS } from "./tasks";

export function tasksTable(): string {
  const rows = TASKS.map(
    (t) => `| ${t.id} | ${t.arm} | ${t.hitl ? "approved" : "-"} | ${t.hook ? "yes" : "-"} | ${t.refCalls} | ${t.title} |`,
  );
  return ["| id | arm | HITL | mid-task hook | refCalls | what it tests |", "| --- | --- | --- | --- | --- | --- |", ...rows].join("\n");
}

export function promptsList(): string {
  return TASKS.map((t) => `- **${t.id}**: ${t.prompt}`).join("\n");
}

if ((import.meta as unknown as { main?: boolean }).main) {
  process.stdout.write(`${tasksTable()}\n\n### Prompts (verbatim)\n\n${promptsList()}\n`);
}
