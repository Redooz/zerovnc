import type { DesktopAccess } from "../../domain/tasks/contracts.ts";
import type { TaskId } from "../../domain/tasks/task.ts";

// Work handed to the scheduler. Desktop credentials travel in memory only and
// are never persisted.
export interface ScheduledTask {
  readonly taskId: TaskId;
  readonly desktop: DesktopAccess;
}

export interface TaskScheduler {
  // Starts background work for a task. Must return without waiting for it.
  schedule(job: ScheduledTask): void;
  // Cancels running work and resolves once it has stopped.
  stop(): Promise<void>;
}
