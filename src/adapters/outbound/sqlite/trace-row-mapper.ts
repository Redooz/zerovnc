import type { TraceEvent, TraceEventKind } from "../../../domain/execution/types.ts";
import type { TaskId } from "../../../domain/tasks/task.ts";

export interface TraceRow {
  readonly seq: number;
  readonly task_id: string;
  readonly span_id: string;
  readonly parent_span_id: string | null;
  readonly kind: string;
  readonly at: string;
  readonly payload: string;
}

export function traceEventToRow(event: TraceEvent): Omit<TraceRow, "seq"> {
  return {
    task_id: event.taskId,
    span_id: event.spanId,
    parent_span_id: event.parentSpanId,
    kind: event.kind,
    at: event.at.toISOString(),
    payload: JSON.stringify(event.payload),
  };
}

export function rowToTraceEvent(row: TraceRow): TraceEvent {
  return {
    taskId: row.task_id as TaskId,
    spanId: row.span_id,
    parentSpanId: row.parent_span_id,
    kind: row.kind as TraceEventKind,
    at: new Date(row.at),
    payload: JSON.parse(row.payload) as Record<string, unknown>,
  };
}
