import type { Task, TaskId } from "../../domain/tasks/task.ts";

// Persistence port for tasks. Implementations must refuse to overwrite a task
// whose stored status is already terminal.
export interface TaskRepository {
  // Inserts a new task or updates an existing one.
  save(task: Task): Promise<void>;
  findById(id: TaskId): Promise<Task | null>;
  findInProgress(): Promise<readonly Task[]>;
}
