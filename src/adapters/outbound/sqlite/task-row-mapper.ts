// Maps between the domain Task and its SQLite row. Lives beside the repository
// that uses it; the domain never sees row shapes.
import { TASK_STATUSES, type Task, type TaskStatus } from "../../../domain/tasks/task.ts";

export interface TaskRow {
  id: string;
  instruction: string;
  status: string;
  summary: string;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  deadline_at: string;
}

export class TaskRowMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskRowMappingError";
  }
}

function toStatus(value: string): TaskStatus {
  if ((TASK_STATUSES as readonly string[]).includes(value)) {
    return value as TaskStatus;
  }
  throw new TaskRowMappingError(`Unknown stored task status: ${value}`);
}

function toDate(value: string, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TaskRowMappingError(`Invalid stored timestamp in ${field}`);
  }
  return date;
}

export function taskToRow(task: Task): TaskRow {
  return {
    id: task.id,
    instruction: task.instruction,
    status: task.status,
    summary: task.summary,
    created_at: task.createdAt.toISOString(),
    updated_at: task.updatedAt.toISOString(),
    finished_at: task.finishedAt === null ? null : task.finishedAt.toISOString(),
    deadline_at: task.deadlineAt.toISOString(),
  };
}

export function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    instruction: row.instruction,
    status: toStatus(row.status),
    summary: row.summary,
    createdAt: toDate(row.created_at, "created_at"),
    updatedAt: toDate(row.updated_at, "updated_at"),
    finishedAt: row.finished_at === null ? null : toDate(row.finished_at, "finished_at"),
    deadlineAt: toDate(row.deadline_at, "deadline_at"),
  };
}
