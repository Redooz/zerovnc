import type { TraceEvent } from "../../domain/execution/types.ts";

// One line per event: time, kind, span, and payload. Payloads are already redacted
// when recorded; the formatter adds no data of its own.
export function formatTimeline(events: readonly TraceEvent[]): string[] {
  return events.map((event) => {
    const time = event.at.toISOString().slice(11, 23);
    const parent = event.parentSpanId ? ` <${event.parentSpanId}` : "";
    const payload = Object.keys(event.payload).length > 0 ? ` ${JSON.stringify(event.payload)}` : "";
    // An observation without a stored screenshot is still valid; make the gap visible.
    const missing = event.kind === "observation" && event.payload.artifact_ref === null ? "  <- screenshot missing" : "";
    return `${time}  ${event.kind.padEnd(18)} [${event.spanId}${parent}]${payload}${missing}`;
  });
}
