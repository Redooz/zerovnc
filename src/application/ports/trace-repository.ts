import type { TraceEvent } from "../../domain/execution/types.ts";
import type { TaskId } from "../../domain/tasks/task.ts";

// Persistence port for trace events. Events are append-only and returned in the
// order they were appended.
export interface TraceRepository {
  append(events: readonly TraceEvent[]): Promise<void>;
  forTask(taskId: TaskId): Promise<readonly TraceEvent[]>;
}
