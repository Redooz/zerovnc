import type { Task, TaskId } from "../../domain/tasks/task.ts";
import type { TaskRepository } from "../ports/task-repository.ts";

export class GetTask {
  constructor(private readonly repository: TaskRepository) {}

  execute(taskId: TaskId): Promise<Task | null> {
    return this.repository.findById(taskId);
  }
}
