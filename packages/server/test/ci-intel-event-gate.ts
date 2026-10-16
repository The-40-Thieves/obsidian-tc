// Event gating for the macOS Intel legs. A matrix value that keeps the Intel hosts off pull_request
// and merge_group is one expression with two lists: the first is used on those two events, the
// second on every other event. A JSON list reads as fromJSON((COND) && 'PR' || 'OTHER'), a comma
// list as (COND) && 'PR' || 'OTHER'. These helpers read that shape back for the workflow tests.

export const PR_EVENT_CONDITION =
  "github.event_name == 'pull_request' || github.event_name == 'merge_group'";

const JSON_GATE = /^\$\{\{ fromJSON\(\((.+)\) && '(.+)' \|\| '(.+)'\) \}\}$/;
const TEXT_GATE = /^\$\{\{ \((.+)\) && '(.+)' \|\| '(.+)' \}\}$/;

export interface EventGate {
  condition: string;
  onPullRequest: string;
  otherEvents: string;
}

export function eventGate(value: unknown): EventGate {
  const match = typeof value === "string" ? (JSON_GATE.exec(value) ?? TEXT_GATE.exec(value)) : null;
  if (!match) throw new Error(`not an event-gated expression: ${JSON.stringify(value)}`);
  const [, condition = "", onPullRequest = "", otherEvents = ""] = match;
  return { condition, onPullRequest, otherEvents };
}

export function eventGatedList(value: unknown): {
  onPullRequest: unknown[];
  otherEvents: unknown[];
} {
  const gate = eventGate(value);
  return {
    onPullRequest: JSON.parse(gate.onPullRequest) as unknown[],
    otherEvents: JSON.parse(gate.otherEvents) as unknown[],
  };
}
