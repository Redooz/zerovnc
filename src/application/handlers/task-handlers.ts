import type { DesktopAccess, TaskStatusReport } from "../../domain/tasks/contracts.ts";
import type { TaskId } from "../../domain/tasks/task.ts";
import { GetTask } from "../usecases/get-task.ts";
import { SubmitTask } from "../usecases/submit-task.ts";
import { TaskNotFoundError } from "../usecases/errors.ts";

// Handlers translate inbound commands and queries into use case calls and map
// domain results into outbound-neutral DTOs.

export interface SubmitTaskCommand {
  readonly tarea: string;
  readonly escritorio: DesktopAccess;
}

export interface TaskAccepted {
  readonly taskId: TaskId;
}

export class SubmitTaskHandler {
  constructor(private readonly submitTask: SubmitTask) {}

  async handle(command: SubmitTaskCommand): Promise<TaskAccepted> {
    const taskId = await this.submitTask.execute({
      instruction: command.tarea,
      desktop: command.escritorio,
    });
    return { taskId };
  }
}

export class GetTaskHandler {
  constructor(private readonly getTask: GetTask) {}

  async handle(taskId: TaskId): Promise<TaskStatusReport> {
    const task = await this.getTask.execute(taskId);
    if (task === null) {
      throw new TaskNotFoundError(taskId);
    }
    return { estado: task.status, resumen: task.summary };
  }
}
