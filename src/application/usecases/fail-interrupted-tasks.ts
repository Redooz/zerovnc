import { finishTask } from "../../domain/tasks/task.ts";
import type { Clock } from "../ports/clock.ts";
import type { TaskRepository } from "../ports/task-repository.ts";

export const INTERRUPTED_BY_RESTART_SUMMARY =
  "Tarea interrumpida por un reinicio del servicio; no se completó.";

// Run at startup. Tasks still `en_curso` belonged to a process that is gone, so
// they cannot finish and are marked `fallida`.
export class FailInterruptedTasks {
  constructor(
    private readonly deps: {
      readonly repository: TaskRepository;
      readonly clock: Clock;
    },
  ) {}

  async execute(): Promise<number> {
    const pending = await this.deps.repository.findInProgress();
    for (const task of pending) {
      const failed = finishTask(task, "fallida", INTERRUPTED_BY_RESTART_SUMMARY, this.deps.clock.now());
      await this.deps.repository.save(failed);
    }
    return pending.length;
  }
}
