import type { DesktopAccess } from "../../domain/tasks/contracts.ts";
import { createTask, finishTask, type TaskId } from "../../domain/tasks/task.ts";
import type { Clock } from "../ports/clock.ts";
import type { IdGenerator } from "../ports/id-generator.ts";
import type { TaskRepository } from "../ports/task-repository.ts";
import type { TaskScheduler } from "../ports/task-scheduler.ts";

export const NOT_STARTED_SUMMARY = "La tarea no pudo iniciarse en el agente.";

export interface SubmitTaskInput {
  readonly instruction: string;
  readonly desktop: DesktopAccess;
}

export class SubmitTask {
  constructor(
    private readonly deps: {
      readonly repository: TaskRepository;
      readonly scheduler: TaskScheduler;
      readonly clock: Clock;
      readonly ids: IdGenerator;
      readonly timeoutMs: number;
    },
  ) {}

  async execute(input: SubmitTaskInput): Promise<TaskId> {
    const task = createTask({
      id: this.deps.ids.next(),
      instruction: input.instruction,
      now: this.deps.clock.now(),
      timeoutMs: this.deps.timeoutMs,
    });
    await this.deps.repository.save(task);
    try {
      this.deps.scheduler.schedule({ taskId: task.id, desktop: input.desktop });
    } catch (error) {
      // Never leave a stored task en_curso without a worker behind it.
      await this.deps.repository.save(finishTask(task, "fallida", NOT_STARTED_SUMMARY, this.deps.clock.now()));
      throw error;
    }
    return task.id;
  }
}
