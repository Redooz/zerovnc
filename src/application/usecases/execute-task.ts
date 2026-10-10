import type { DesktopAccess } from "../../domain/tasks/contracts.ts";
import { finishTask, isTerminal, type TaskId } from "../../domain/tasks/task.ts";
import type { Clock } from "../ports/clock.ts";
import type { TaskRepository } from "../ports/task-repository.ts";

export const NOT_IMPLEMENTED_SUMMARY = "Ejecución no implementada todavía (fase 1).";
export const CANCELLED_SUMMARY = "Tarea interrumpida: el servicio se está cerrando.";
export const INTERNAL_ERROR_SUMMARY = "Error interno durante la ejecución; la tarea no se completó.";

export interface ExecuteTaskInput {
  readonly taskId: TaskId;
  readonly desktop: DesktopAccess;
  readonly signal: AbortSignal;
}

// Phase 1 placeholder: the real agent loop arrives in Phase 4. Until then every
// task ends as `fallida`. Cancellation is honored first, and unexpected errors
// still end the task so that nothing is left `en_curso` without a worker.
export class ExecuteTask {
  constructor(
    private readonly deps: {
      readonly repository: TaskRepository;
      readonly clock: Clock;
    },
  ) {}

  async execute(input: ExecuteTaskInput): Promise<void> {
    try {
      const task = await this.deps.repository.findById(input.taskId);
      if (task === null || isTerminal(task.status)) {
        return;
      }
      const summary = input.signal.aborted ? CANCELLED_SUMMARY : NOT_IMPLEMENTED_SUMMARY;
      await this.deps.repository.save(finishTask(task, "fallida", summary, this.deps.clock.now()));
    } catch (error) {
      await this.failAfterError(input.taskId);
      throw error;
    }
  }

  private async failAfterError(taskId: TaskId): Promise<void> {
    try {
      const task = await this.deps.repository.findById(taskId);
      if (task !== null && !isTerminal(task.status)) {
        await this.deps.repository.save(finishTask(task, "fallida", INTERNAL_ERROR_SUMMARY, this.deps.clock.now()));
      }
    } catch {
      // The original error is rethrown by the caller; the startup recovery
      // pass will mark the task fallida if this write also failed.
    }
  }
}
