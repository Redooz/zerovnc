import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/adapters/outbound/sqlite/database.ts";
import { SqliteKnowledgeRepository, MAX_NOTES_PER_APP, MAX_STEPS_PER_NOTE } from "../../src/adapters/outbound/sqlite/sqlite-knowledge-repository.ts";

const db = () => openDatabase(":memory:");

const save = (repo: SqliteKnowledgeRepository, steps: string[], over: { appKey?: string; screenKey?: string } = {}) =>
  repo.save({ appKey: over.appKey ?? "app-1", screenKey: over.screenKey ?? "screen-1", steps, taskId: "t1" });

describe("SqliteKnowledgeRepository", () => {
  test("stores steps and returns them newest first, tagged with the screen they came from", async () => {
    const repository = new SqliteKnowledgeRepository(db());
    await save(repository, ['clicked "Comercial"']);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await save(repository, ['clicked "Cartera"', 'clicked "Facturas"']);
    const notes = await repository.forApp("app-1", 10);
    expect(notes[0]!.steps).toEqual(['clicked "Cartera"', 'clicked "Facturas"']);
    expect(notes[1]!.steps).toEqual(['clicked "Comercial"']);
    expect(notes[0]!.screenKey).toBe("screen-1");
    expect(notes[0]!.createdAt.getTime()).toBeGreaterThan(notes[1]!.createdAt.getTime());
  });

  test("notes are scoped to one app", async () => {
    const repository = new SqliteKnowledgeRepository(db());
    await save(repository, ['clicked "Clientes"']);
    await save(repository, ['clicked "Ventas"'], { appKey: "app-2" });
    expect(await repository.forApp("app-1", 10)).toHaveLength(1);
    expect(await repository.forApp("app-3", 10)).toHaveLength(0);
  });

  test("at most maxPerApp notes are kept per app, newest first", async () => {
    const repository = new SqliteKnowledgeRepository(db(), { maxPerApp: 3 });
    for (let i = 0; i < 6; i++) {
      await save(repository, [`step-${i}`]);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const notes = await repository.forApp("app-1", 10);
    expect(notes).toHaveLength(3);
    expect(notes.map((n) => n.steps[0])).toEqual(["step-5", "step-4", "step-3"]);
  });

  test("notes older than the window are not offered", async () => {
    const repository = new SqliteKnowledgeRepository(db(), { ttlMs: 0 });
    await save(repository, ['clicked "Clientes"']);
    expect(await repository.forApp("app-1", 10)).toHaveLength(0);
  });

  test("the limit bounds how many notes a task can read", async () => {
    const repository = new SqliteKnowledgeRepository(db());
    for (let i = 0; i < 4; i++) await save(repository, [`step-${i}`]);
    expect(await repository.forApp("app-1", 2)).toHaveLength(2);
    expect(await repository.forApp("app-1", 0)).toHaveLength(0);
  });

  test("an empty note is dropped, and a long one is bounded at both ends", async () => {
    const repository = new SqliteKnowledgeRepository(db());
    await save(repository, []);
    await save(repository, Array.from({ length: MAX_STEPS_PER_NOTE + 5 }, (_, i) => `step-${i}`));
    await save(repository, ["x".repeat(500)]);
    const stored = await repository.forApp("app-1", 10);
    // Empty dropped; the step count is capped; a single over-long step is truncated.
    expect(stored).toHaveLength(2);
    const lengths = stored.map((note) => note.steps.length).sort((x, y) => y - x);
    expect(lengths).toEqual([MAX_STEPS_PER_NOTE, 1]);
    const truncated = stored.find((note) => note.steps.length === 1)!;
    expect(truncated.steps[0]!.length).toBe(80);
  });

  test("migration is idempotent: a second process sees the same table", () => {
    const database = db();
    new SqliteKnowledgeRepository(database);
    expect(() => new SqliteKnowledgeRepository(database)).not.toThrow();
    expect(database.query<{ version: number }, []>("SELECT COUNT(*) AS version FROM schema_migrations WHERE version = 3").get()?.version).toBe(1);
    database.close();
  });

  test("the cap constant matches the adapter default", () => {
    expect(MAX_NOTES_PER_APP).toBe(5);
  });
});