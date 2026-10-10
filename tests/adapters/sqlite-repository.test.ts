import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openDatabase, migrate } from "../../src/adapters/outbound/sqlite/database.ts";
import { SqliteTaskRepository } from "../../src/adapters/outbound/sqlite/sqlite-task-repository.ts";
import { rowToTask, TaskRowMappingError, type TaskRow } from "../../src/adapters/outbound/sqlite/task-row-mapper.ts";
import { createTask, finishTask, InvalidTaskTransitionError } from "../../src/domain/tasks/task.ts";

const NOW = new Date("2026-10-10T12:00:00.000Z");
const dirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "zerovnc-db-"));
  dirs.push(dir);
  return join(dir, "nested", "agent.sqlite");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SqliteTaskRepository", () => {
  test("round-trips a task and its terminal state", async () => {
    const db = openDatabase(tempDbPath());
    const repo = new SqliteTaskRepository(db);
    const task = createTask({ id: "a", instruction: "Haz algo", now: NOW, timeoutMs: 1000 });
    await repo.save(task);
    expect((await repo.findById("a"))?.status).toBe("en_curso");
    await repo.save(finishTask(task, "terminada", "hecho", NOW));
    const stored = await repo.findById("a");
    expect(stored?.status).toBe("terminada");
    expect(stored?.summary).toBe("hecho");
    expect(stored?.instruction).toBe("Haz algo");
    expect(await repo.findById("missing")).toBeNull();
    db.close();
  });

  test("refuses to overwrite a terminal task", async () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteTaskRepository(db);
    const task = createTask({ id: "b", instruction: "x", now: NOW, timeoutMs: 1000 });
    await repo.save(finishTask(task, "fallida", "motivo", NOW));
    await expect(repo.save(finishTask(task, "terminada", "otro", NOW))).rejects.toBeInstanceOf(
      InvalidTaskTransitionError,
    );
    expect((await repo.findById("b"))?.summary).toBe("motivo");
    db.close();
  });

  test("lists only tasks still in progress", async () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteTaskRepository(db);
    const running = createTask({ id: "r", instruction: "x", now: NOW, timeoutMs: 1000 });
    const finished = finishTask(createTask({ id: "f", instruction: "x", now: NOW, timeoutMs: 1000 }), "terminada", "ok", NOW);
    await repo.save(running);
    await repo.save(finished);
    expect((await repo.findInProgress()).map((t) => t.id)).toEqual(["r"]);
    db.close();
  });

  test("migrations are applied once", () => {
    const db = openDatabase(":memory:");
    expect(migrate(db)).toBe(0);
    const rows = db.query<{ version: number }, []>("SELECT version FROM schema_migrations").all();
    expect(rows).toEqual([{ version: 1 }]);
    db.close();
  });

  test("the database rejects unknown statuses at the storage layer", () => {
    const db = openDatabase(":memory:");
    expect(() =>
      db.exec(
        "INSERT INTO tasks (id, instruction, status, summary, created_at, updated_at, deadline_at) VALUES ('x','y','bogus','','','','')",
      ),
    ).toThrow();
    db.close();
  });
});

describe("task row mapper", () => {
  test("rejects a stored status outside the vocabulary", () => {
    const row: TaskRow = {
      id: "c",
      instruction: "x",
      status: "archivada",
      summary: "",
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
      finished_at: null,
      deadline_at: NOW.toISOString(),
    };
    expect(() => rowToTask(row)).toThrow(TaskRowMappingError);
  });

  test("survives a reopen of the same file (restart)", async () => {
    const path = tempDbPath();
    const first = openDatabase(path);
    await new SqliteTaskRepository(first).save(
      finishTask(createTask({ id: "p", instruction: "x", now: NOW, timeoutMs: 1000 }), "terminada", "persistido", NOW),
    );
    first.close();
    const second = new Database(path, { strict: true });
    const stored = await new SqliteTaskRepository(second).findById("p");
    expect(stored?.summary).toBe("persistido");
    second.close();
  });
});
