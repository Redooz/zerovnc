import { describe, expect, test } from "bun:test";
import {
  createTask,
  finishTask,
  InvalidTaskTransitionError,
  isPastDeadline,
  TaskDomainError,
} from "../../src/domain/tasks/task.ts";
import { TaskSubmissionSchema } from "../../src/domain/tasks/contracts.ts";

const NOW = new Date("2026-10-10T12:00:00.000Z");

function newTask() {
  return createTask({ id: "t-1", instruction: "  Registra al cliente X  ", now: NOW, timeoutMs: 300_000 });
}

describe("task entity", () => {
  test("starts en_curso with trimmed instruction and a deadline", () => {
    const task = newTask();
    expect(task.status).toBe("en_curso");
    expect(task.instruction).toBe("Registra al cliente X");
    expect(task.summary).toBe("");
    expect(task.deadlineAt.toISOString()).toBe("2026-10-10T12:05:00.000Z");
  });

  test("rejects empty id, empty instruction, and bad timeout", () => {
    expect(() => createTask({ id: " ", instruction: "x", now: NOW, timeoutMs: 1 })).toThrow(TaskDomainError);
    expect(() => createTask({ id: "a", instruction: "   ", now: NOW, timeoutMs: 1 })).toThrow(TaskDomainError);
    expect(() => createTask({ id: "a", instruction: "x", now: NOW, timeoutMs: 0 })).toThrow(TaskDomainError);
  });

  test("en_curso moves to terminada or fallida with a summary", () => {
    const later = new Date(NOW.getTime() + 1000);
    const done = finishTask(newTask(), "terminada", " listo ", later);
    expect(done.status).toBe("terminada");
    expect(done.summary).toBe("listo");
    expect(done.finishedAt?.getTime()).toBe(later.getTime());
    const failed = finishTask(newTask(), "fallida", "motivo", later);
    expect(failed.status).toBe("fallida");
  });

  test("refuses any transition out of a terminal state", () => {
    const done = finishTask(newTask(), "terminada", "ok", NOW);
    expect(() => finishTask(done, "fallida", "cambio", NOW)).toThrow(InvalidTaskTransitionError);
    expect(() => finishTask(done, "terminada", "otra vez", NOW)).toThrow(InvalidTaskTransitionError);
    const failed = finishTask(newTask(), "fallida", "motivo", NOW);
    expect(() => finishTask(failed, "terminada", "ok", NOW)).toThrow(InvalidTaskTransitionError);
  });

  test("a finished task needs a non-empty summary", () => {
    expect(() => finishTask(newTask(), "terminada", "  ", NOW)).toThrow(TaskDomainError);
  });

  test("deadline is inclusive at the limit", () => {
    const task = newTask();
    expect(isPastDeadline(task, new Date(NOW.getTime() + 299_999))).toBe(false);
    expect(isPastDeadline(task, new Date(NOW.getTime() + 300_000))).toBe(true);
  });
});

describe("task submission contract", () => {
  const valid = {
    tarea: "Registra al cliente X",
    escritorio: { url: "wss://escritorio.example/websockify", password: "secreto" },
  };

  test("accepts a valid request", () => {
    expect(TaskSubmissionSchema.safeParse(valid).success).toBe(true);
  });

  test("rejects non-websocket desktop URLs and empty fields", () => {
    expect(
      TaskSubmissionSchema.safeParse({ ...valid, escritorio: { ...valid.escritorio, url: "https://x.example" } })
        .success,
    ).toBe(false);
    expect(TaskSubmissionSchema.safeParse({ ...valid, tarea: "   " }).success).toBe(false);
    expect(TaskSubmissionSchema.safeParse({ ...valid, escritorio: { url: valid.escritorio.url, password: "" } }).success).toBe(false);
    expect(TaskSubmissionSchema.safeParse({ tarea: "x" }).success).toBe(false);
  });
});
