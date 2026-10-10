import type { ScheduledTask, TaskScheduler } from "../../../application/ports/task-scheduler.ts";
import type { Logger } from "../../../application/ports/logger.ts";
import type { TaskId } from "../../../domain/tasks/task.ts";

export type TaskRunner = (job: ScheduledTask, signal: AbortSignal) => Promise<void>;

interface RunningTask {
  readonly controller: AbortController;
  readonly done: Promise<void>;
}

// Runs tasks in the background of the same process. Each task gets its own
// AbortController; stop() cancels every running task and waits for them to exit.
export class InProcessTaskScheduler implements TaskScheduler {
  private readonly running = new Map<TaskId, RunningTask>();
  private stopping = false;

  constructor(
    private readonly deps: {
      readonly run: TaskRunner;
      readonly logger: Logger;
    },
  ) {}

  schedule(job: ScheduledTask): void {
    if (this.stopping) {
      throw new Error("scheduler is stopping");
    }
    if (this.running.has(job.taskId)) {
      return;
    }
    const controller = new AbortController();
    const done = this.deps
      .run(job, controller.signal)
      .catch((error: unknown) => {
        this.deps.logger.error("task runner crashed", {
          task_id: job.taskId,
          reason: error instanceof Error ? error.name : "unknown",
        });
      })
      .finally(() => {
        this.running.delete(job.taskId);
      });
    this.running.set(job.taskId, { controller, done });
  }

  get runningCount(): number {
    return this.running.size;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const task of this.running.values()) {
      task.controller.abort();
    }
    await Promise.allSettled([...this.running.values()].map((task) => task.done));
  }
}
