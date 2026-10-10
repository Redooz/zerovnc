// Task entity and state transitions. Pure domain code: no I/O, no framework types.

export const TASK_STATUSES = ["en_curso", "terminada", "fallida"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TERMINAL_STATUSES = ["terminada", "fallida"] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export type TaskId = string;

export interface Task {
  readonly id: TaskId;
  readonly instruction: string;
  readonly status: TaskStatus;
  readonly summary: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly finishedAt: Date | null;
  readonly deadlineAt: Date;
}

export class TaskDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskDomainError";
  }
}

export class InvalidTaskTransitionError extends TaskDomainError {
  constructor(
    readonly taskId: TaskId,
    readonly from: TaskStatus,
    readonly to: TaskStatus,
  ) {
    super(`Task ${taskId} cannot move from ${from} to ${to}`);
    this.name = "InvalidTaskTransitionError";
  }
}

export function isTerminal(status: TaskStatus): status is TerminalStatus {
  return status === "terminada" || status === "fallida";
}

export function isTerminalStatus(value: string): value is TerminalStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(value);
}

export interface NewTaskInput {
  readonly id: TaskId;
  readonly instruction: string;
  readonly now: Date;
  readonly timeoutMs: number;
}

export function createTask(input: NewTaskInput): Task {
  const instruction = input.instruction.trim();
  if (input.id.trim() === "") {
    throw new TaskDomainError("Task id must not be empty");
  }
  if (instruction === "") {
    throw new TaskDomainError("Task instruction must not be empty");
  }
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new TaskDomainError("Task timeout must be a positive number of milliseconds");
  }
  return {
    id: input.id,
    instruction,
    status: "en_curso",
    summary: "",
    createdAt: input.now,
    updatedAt: input.now,
    finishedAt: null,
    deadlineAt: new Date(input.now.getTime() + input.timeoutMs),
  };
}

// Moves an en_curso task to a terminal status. Any transition out of a terminal
// status is refused, so a finished task can never be reported differently later.
export function finishTask(
  task: Task,
  outcome: TerminalStatus,
  summary: string,
  now: Date,
): Task {
  if (isTerminal(task.status)) {
    throw new InvalidTaskTransitionError(task.id, task.status, outcome);
  }
  const trimmed = summary.trim();
  if (trimmed === "") {
    throw new TaskDomainError("A finished task needs a non-empty summary");
  }
  return {
    ...task,
    status: outcome,
    summary: trimmed,
    updatedAt: now,
    finishedAt: now,
  };
}

export function isPastDeadline(task: Task, now: Date): boolean {
  return now.getTime() >= task.deadlineAt.getTime();
}
