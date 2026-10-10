import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadPracticeFixtures, toAgentSubmission } from "../../evals/fixtures.ts";

const PRACTICE_DIR = resolve(import.meta.dir, "../../../frontier-reto-1/pruebas");
const available = existsSync(PRACTICE_DIR);

describe("practice fixtures", () => {
  test.skipIf(!available)("loads all five practice files", async () => {
    const loaded = await loadPracticeFixtures(PRACTICE_DIR);
    expect(loaded.map((l) => l.fixture.id)).toEqual(["E1", "E2", "E3", "E4", "E5"]);
    const e3 = loaded.find((l) => l.fixture.id === "E3");
    expect(e3?.fixture.respuesta_esperada).toBe("45");
  });

  test.skipIf(!available)("the agent submission contains only instruction and desktop access", async () => {
    const [first] = await loadPracticeFixtures(PRACTICE_DIR);
    if (!first) throw new Error("no fixtures");
    const submission = toAgentSubmission(first.fixture, { url: "wss://d.example/websockify", password: "pw" });
    expect(Object.keys(submission).sort()).toEqual(["escritorio", "tarea"]);
    expect(Object.keys(submission.escritorio).sort()).toEqual(["password", "url"]);
    const serialized = JSON.stringify(submission);
    expect(serialized).not.toContain("estado_esperado");
    expect(serialized).not.toContain("diff_esperado");
  });

  test("a fixture with an invalid status is rejected", async () => {
    const { PracticeFixtureSchema } = await import("../../evals/fixtures.ts");
    expect(
      PracticeFixtureSchema.safeParse({ id: "X", nivel: "f", instruccion: "x", estado_esperado: "quizas", diff_esperado: [] }).success,
    ).toBe(false);
  });
});
