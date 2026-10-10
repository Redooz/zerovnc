import type { Database } from "bun:sqlite";
import type { TraceRepository } from "../../../application/ports/trace-repository.ts";
import type { TraceEvent } from "../../../domain/execution/types.ts";
import type { TaskId } from "../../../domain/tasks/task.ts";
import { rowToTraceEvent, traceEventToRow, type TraceRow } from "./trace-row-mapper.ts";

export class SqliteTraceRepository implements TraceRepository {
  constructor(private readonly db: Database) {}

  async append(events: readonly TraceEvent[]): Promise<void> {
    const insert = this.db.query(
      `INSERT INTO trace_events (task_id, span_id, parent_span_id, kind, at, payload)
       VALUES ($task_id, $span_id, $parent_span_id, $kind, $at, $payload)`,
    );
    const write = this.db.transaction(() => {
      for (const event of events) {
        insert.run(traceEventToRow(event));
      }
    });
    write();
  }

  async forTask(taskId: TaskId): Promise<readonly TraceEvent[]> {
    return this.db
      .query<TraceRow, [string]>("SELECT * FROM trace_events WHERE task_id = ? ORDER BY seq")
      .all(taskId)
      .map(rowToTraceEvent);
  }
}
