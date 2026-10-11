// What a verified task may teach a later task, and what it may never teach. These run the real
// use case, the real tools, and the real SQLite knowledge table with a scripted planner and stubbed
// models: no model calls, no desktop.
import { afterEach, describe, expect, test } from "bun:test";
import { type Database } from "bun:sqlite";
import { openDatabase } from "../../src/adapters/outbound/sqlite/database.ts";
import { SqliteKnowledgeRepository } from "../../src/adapters/outbound/sqlite/sqlite-knowledge-repository.ts";
import { appKeyOf } from "../../src/application/knowledge/knowledge.ts";
import { MAX_NOTES_PER_TASK, ExecuteTask } from "../../src/application/usecases/execute-task.ts";
import { renderState } from "../../src/application/agent/agent-loop.ts";
import { DesktopOwnership } from "../../src/application/desktop/desktop-ownership.ts";
import { SqliteTaskRepository } from "../../src/adapters/outbound/sqlite/sqlite-task-repository.ts";
import { SqliteTraceRepository } from "../../src/adapters/outbound/sqlite/sqlite-trace-repository.ts";
import { TraceRecorder } from "../../src/application/trace/trace-recorder.ts";
import { createTask } from "../../src/domain/tasks/task.ts";
import { TaskRunState } from "../../src/application/tools/run-state.ts";
import type { DesktopAccess } from "../../src/domain/tasks/contracts.ts";
import type { ObservedElement } from "../../src/domain/perception/observation.ts";
import { ScriptedPlanner, stubModels, decisionRoute, perceptionRoute, type ToolCallSpec } from "../support/agent-doubles.ts";

const DESKTOP: DesktopAccess = { url: "wss://desktop.example/websockify", password: "pw-12345678" };
const APP_KEY = appKeyOf(DESKTOP.url);
const PLAN = { goal: "Registrar", completion_conditions: ["Guardar is visible"] };

const ELEMENTS: ObservedElement[] = [
  { id: "save", label: "Guardar", kind: "button", value: { state: "not_applicable" }, box: { x: 0, y: 0, w: 2, h: 2 }, visible: true },
  { id: "name", label: "Nombre", kind: "text_field", value: { state: "text", text: "Ana Torres" }, box: { x: 2, y: 2, w: 2, h: 2 }, visible: true },
  { id: "row", label: "Ana Torres Ruiz | 3157654321", kind: "table_row", value: { state: "not_applicable" }, box: { x: 0, y: 4, w: 8, h: 2 }, visible: true },
];

let open: Database[] = [];
afterEach(() => {
  for (const database of open) database.close();
  open = [];
});

interface TaskRun {
  readonly status: string;
  readonly summary: string;
  readonly notes: Awaited<ReturnType<SqliteKnowledgeRepository["forApp"]>>;
}

async function runTask(opts: {
  plan?: (cycle: number) => readonly ToolCallSpec[] | "end";
  level?: string;
  learning?: boolean;
}): Promise<TaskRun> {
  const database = openDatabase(":memory:");
  open.push(database);
  const repository = new SqliteTaskRepository(database);
  const knowledge = new SqliteKnowledgeRepository(database);
  const models = stubModels();
  const task = createTask({ id: `t-${Math.random().toString(36).slice(2, 8)}`, instruction: "Registra a Ana Torres", now: new Date(), timeoutMs: 60_000 });
  await repository.save(task);
  let counter = 0;
  const execute = new ExecuteTask({
    repository,
    clock: { now: () => new Date() },
    ids: { next: () => `id-${++counter}` },
    ownership: new DesktopOwnership({ now: () => new Date() }),
    sessions: {
      async connect() {
        let frame = 0;
        return {
          screen: { width: 8, height: 8 },
          async capture(input: { observationId: string }) {
            frame += 1;
            return { observationId: input.observationId, capturedAt: new Date(), width: 8, height: 8, frameRevision: frame, rgba: new Uint8Array(8 * 8 * 4) };
          },
          async pointer() {},
          async key() {},
          async close() {},
        };
      },
    },
    trace: new TraceRecorder({
      repository: new SqliteTraceRepository(database),
      clock: { now: () => new Date() },
      ids: { next: () => `s-${++counter}` },
      logger: { info() {}, error() {} },
    }),
    artifacts: { async storeScreenshot() { return { ref: "x.png", sha256: "0", bytes: 0 }; } },
    agent: {
      planner: new ScriptedPlanner((async (_input: unknown, cycle: number) =>
        (opts.plan?.(cycle) ?? [{ name: "set_plan", args: PLAN }]) as never) as never),
      perception: { primary: perceptionRoute(ELEMENTS), fallback: perceptionRoute(ELEMENTS), timeoutMs: 5_000 },
      perceptionCacheVersion: "test",
      grounding: { primary: decisionRoute({ level: opts.level }), fallback: models.decision.fallback, timeoutMs: 5_000 },
      frameCache: { maxEntries: 4, ttlMs: 60_000 },
      knowledge,
      learning: opts.learning ?? true,
    },
  });
  await execute.execute({ taskId: task.id, desktop: DESKTOP, signal: new AbortController().signal });
  const stored = await repository.findById(task.id);
  return { status: stored?.status ?? "?", summary: stored?.summary ?? "", notes: await knowledge.forApp(APP_KEY, MAX_NOTES_PER_TASK) };
}

// Verifies in cycle 2 after acting in cycle 1.
const CLICK_THEN_VERIFY = (cycle: number): readonly ToolCallSpec[] | "end" =>
  cycle === 1
    ? [{ name: "set_plan", args: PLAN }, { name: "click_control", args: { control: "Guardar" } }]
    : [{ name: "verify_result", args: {} }];

describe("what a verified task teaches", () => {
  test("a verified task stores one note with the UI targets it acted on", async () => {
    const run = await runTask({ plan: CLICK_THEN_VERIFY });
    expect(run.status).toBe("terminada");
    expect(run.notes).toHaveLength(1);
    expect(run.notes[0]!.steps).toEqual(['clicked "Guardar"']);
  });

  test("a note holds no value, no record identity, and no secret", async () => {
    const run = await runTask({
      plan: (cycle) =>
        cycle === 1
          ? [{ name: "set_plan", args: PLAN }, { name: "replace_field", args: { field: "Nombre", text: "Ana Torres" } }]
          : cycle === 2
            ? [{ name: "select_record", args: { identity: "Ana Torres Ruiz" } }]
            : [{ name: "verify_result", args: {} }],
    });
    expect(run.status).toBe("terminada");
    expect(run.notes[0]!.steps).toEqual(['filled in "Nombre"']);
    const text = JSON.stringify(run.notes);
    expect(text).not.toContain("Ana Torres");
    expect(text).not.toContain("3157654321");
    expect(text).not.toContain(DESKTOP.password);
    // Selecting a record teaches nothing: its label is the record text.
    expect(run.notes[0]!.steps.join(" ")).not.toContain("selected");
  });

  test("a failed task teaches nothing", async () => {
    const run = await runTask({ plan: () => [{ name: "report_blocker", args: { reason: "ambiguo" } }] });
    expect(run.status).toBe("fallida");
    expect(run.notes).toHaveLength(0);
  });

  test("with learning off nothing is written", async () => {
    const run = await runTask({ plan: CLICK_THEN_VERIFY, learning: false });
    expect(run.status).toBe("terminada");
    expect(run.notes).toHaveLength(0);
  });

  test("a refused action teaches nothing", async () => {
    // click_control on a stale observation is refused, so nothing was acted on.
    const run = await runTask({ plan: (cycle) => (cycle === 1 ? [{ name: "click_control", args: { control: "Guardar" } }] : [{ name: "report_blocker", args: { reason: "sin observación" } }]) });
    expect(run.notes).toHaveLength(0);
  });
});

function stateStartingAt(screenKey: string | null): TaskRunState {
  const state = new TaskRunState();
  state.startScreenKey = screenKey;
  return state;
}

describe("what a later task reads", () => {
  test("the state shows a note only when the task starts on the screen it was verified from", async () => {
    const run = await runTask({ plan: CLICK_THEN_VERIFY });
    const matching = renderState(stateStartingAt(run.notes[0]!.screenKey), 60_000, run.notes);
    expect(matching).toContain("Previously verified");
    expect(matching).toContain('clicked "Guardar"');

    const different = renderState(stateStartingAt("somewhere-else"), 60_000, run.notes);
    expect(different).not.toContain("Previously verified");
  });

  test("no notes means no section, so nothing changes in the prompt", () => {
    const without = renderState(stateStartingAt("k"), 60_000);
    const withEmpty = renderState(stateStartingAt("k"), 60_000, []);
    expect(without).toBe(withEmpty);
  });
});