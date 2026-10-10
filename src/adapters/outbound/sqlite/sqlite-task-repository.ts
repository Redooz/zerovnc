import type { Database } from "bun:sqlite";
import { InvalidTaskTransitionError, isTerminal, type Task, type TaskId } from "../../../domain/tasks/task.ts";
import type { TaskRepository } from "../../../application/ports/task-repository.ts";
import { rowToTask, taskToRow, type TaskRow } from "./task-row-mapper.ts";

export class SqliteTaskRepository implements TaskRepository {
  constructor(private readonly db: Database) {}

  async save(task: Task): Promise<void> {
    const row = taskToRow(task);
    // Check and write in one transaction so a terminal task can never be
    // overwritten, even by a concurrent writer.
    const write = this.db.transaction(() => {
      const stored = this.db
        .query<{ status: string }, [string]>("SELECT status FROM tasks WHERE id = ?")
        .get(task.id);
      if (stored !== null && isTerminal(stored.status as Task["status"])) {
        throw new InvalidTaskTransitionError(task.id, stored.status as Task["status"], task.status);
      }
      this.db
        .query(
          `INSERT INTO tasks (id, instruction, status, summary, created_at, updated_at, finished_at, deadline_at)
           VALUES ($id, $instruction, $status, $summary, $created_at, $updated_at, $finished_at, $deadline_at)
           ON CONFLICT(id) DO UPDATE SET
             status = excluded.status,
             summary = excluded.summary,
             updated_at = excluded.updated_at,
             finished_at = excluded.finished_at`,
        )
        .run({
          id: row.id,
          instruction: row.instruction,
          status: row.status,
          summary: row.summary,
          created_at: row.created_at,
          updated_at: row.updated_at,
          finished_at: row.finished_at,
          deadline_at: row.deadline_at,
        });
    });
    write();
  }

  async findById(id: TaskId): Promise<Task | null> {
    const row = this.db.query<TaskRow, [string]>("SELECT * FROM tasks WHERE id = ?").get(id);
    return row === null ? null : rowToTask(row);
  }

  async findInProgress(): Promise<readonly Task[]> {
    return this.db
      .query<TaskRow, []>("SELECT * FROM tasks WHERE status = 'en_curso' ORDER BY created_at")
      .all()
      .map(rowToTask);
  }
}
