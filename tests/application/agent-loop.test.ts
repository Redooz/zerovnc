import { describe, expect, test } from "bun:test";
import {
  nextStepAfterVerification,
  DEADLINE_SUMMARY,
  MAX_CYCLES,
  MAX_CYCLES_SUMMARY,
  MAX_IDLE_CYCLES,
  NO_PLAN_SUMMARY,
  OBSERVE_FAILED_SUMMARY,
  PLANNER_FAILED_SUMMARY,
  runAgentLoop,
  type LoopOutcome,
} from "../../src/application/agent/agent-loop.ts";
import { createTaskToolSet, type DesktopToolDeps } from "../../src/application/tools/desktop-tools.ts";
import { TaskRunState } from "../../src/application/tools/run-state.ts";
import { GroundingService } from "../../src/application/grounding/grounding-service.ts";
import { PerceiveScreen } from "../../src/application/perception/perceive-screen.ts";
import { transcriptChars } from "../../src/application/agent/transcript.ts";
import type { ObservedElement } from "../../src/domain/perception/observation.ts";
import { ScriptedPlanner, chooseElement, decisionRoute, perceptionRoute, TEST_ELEMENTS, type ToolCallSpec } from "../support/agent-doubles.ts";
import { fakeDesktop, inputsOf, type FakeDesktop } from "../support/fake-desktop.ts";

const INSTRUCTION = "Registra al cliente Ana Torres con teléfono 3157654321.";
const PASSWORD = "clave-secreta-del-escritorio";

interface Run {
  readonly outcome: LoopOutcome;
  readonly planner: ScriptedPlanner;
  readonly desk: FakeDesktop;
  readonly traces: Array<{ kind: string; payload: Record<string, unknown> }>;
}

async function run(
  script: (input: Parameters<ConstructorParameters<typeof ScriptedPlanner>[0]>[0], cycle: number) => Promise<readonly ToolCallSpec[] | "end" | "error">,
  opts: { elements?: ObservedElement[]; level?: string | (() => string); choose?: (r: never) => string; deadlineInMs?: number } = {},
): Promise<Run> {
  const desk = fakeDesktop({ deadlineInMs: opts.deadlineInMs });
  const state = new TaskRunState();
  const perception = new PerceiveScreen({
    primary: perceptionRoute(opts.elements ?? TEST_ELEMENTS),
    fallback: perceptionRoute(opts.elements ?? TEST_ELEMENTS),
    timeoutMs: 5_000,
  });
  const decision = decisionRoute({ level: opts.level, choose: opts.choose as never });
  const grounding = new GroundingService({ primary: decision, fallback: decision, timeoutMs: 5_000 });
  const deadlineAt = new Date(desk.clock.now().getTime() + (opts.deadlineInMs ?? 300_000));
  const toolDeps: DesktopToolDeps = {
    taskId: "task-1",
    executor: desk.executor,
    perception,
    grounding,
    state,
    clock: desk.clock,
    deadlineAt,
    signal: desk.controller.signal,
  };
  const tools = createTaskToolSet(toolDeps, { now: () => desk.clock.now().getTime(), onInvocation: () => {} });
  const planner = new ScriptedPlanner(script);
  const traces: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const outcome = await runAgentLoop({
    instruction: INSTRUCTION,
    planner,
    tools,
    toolDeps,
    clock: desk.clock,
    signal: desk.controller.signal,
    deadlineAt,
    trace: (kind, payload) => traces.push({ kind, payload }),
    onModelCall: () => {},
    secrets: [PASSWORD],
  });
  return { outcome, planner, desk, traces };
}

const VERIFY_CONDITIONS = { goal: "Registrar a Ana", completion_conditions: ["Ana Torres appears in the client list"] };

describe("the only path to terminada is current verification", () => {
  test("terminada after verification passes with no input since", async () => {
    const r = await run(async (_input, cycle) => (cycle === 1 ? [{ name: "set_plan", args: VERIFY_CONDITIONS }, { name: "verify_result", args: {} }] : "end"));
    expect(r.outcome).toEqual({
      kind: "finished",
      status: "terminada",
      summary: "Tarea completada. Condiciones verificadas: Ana Torres appears in the client list.",
    });
    expect(r.planner.cycles).toBe(1);
  });

  test("a planner that stops without a plan cannot complete the task: it stalls after two idle turns", async () => {
    const r = await run(async () => "end");
    expect(r.outcome).toEqual({ kind: "finished", status: "fallida", summary: NO_PLAN_SUMMARY });
    expect(r.planner.cycles).toBe(MAX_IDLE_CYCLES);
    expect(r.traces.map((t) => t.kind)).toContain("stalled");
    expect((r.planner.seen[1]!.at(-1) as { text: string }).text).toContain("Plan: none yet");
  });

  test("a planner that keeps working without ever verifying ends at the cycle limit", async () => {
    const r = await run(async () => [{ name: "observe_screen", args: {} }]);
    expect(r.outcome).toEqual({ kind: "finished", status: "fallida", summary: MAX_CYCLES_SUMMARY });
    expect(r.planner.cycles).toBe(MAX_CYCLES);
  });

  test("input after a passing verification voids it: the task does not complete", async () => {
    const r = await run(
      async (_input, cycle) => {
        // Verified, then an action in the same cycle: the evidence is now stale.
        if (cycle === 1) return [{ name: "set_plan", args: VERIFY_CONDITIONS }, { name: "verify_result", args: {} }, { name: "click_control", args: { control: "Guardar" } }];
        return [{ name: "report_blocker", args: { reason: "no se comprobó el cambio" } }];
      },
    );
    expect(r.outcome).toEqual({ kind: "finished", status: "fallida", summary: "La tarea no se pudo completar: no se comprobó el cambio" });
    expect(inputsOf(r.desk.log).length).toBeGreaterThan(0);
  });

  test("a verification with an unsupported condition does not complete the task", async () => {
    const r = await run(
      async (_input, cycle) => (cycle === 1 ? [{ name: "set_plan", args: VERIFY_CONDITIONS }, { name: "verify_result", args: {} }] : [{ name: "report_blocker", args: { reason: "falta el cliente" } }]),
      { level: "not_supported" },
    );
    expect(r.outcome).toEqual({ kind: "finished", status: "fallida", summary: "La tarea no se pudo completar: falta el cliente" });
    expect((r.planner.seen[1]!.at(-1) as { text: string }).text).toContain("not passed");
  });
});

describe("failures end the task with a reason and no hidden success", () => {
  test("a blocker ends the task as fallida, with secrets redacted from the summary", async () => {
    const r = await run(async () => [{ name: "report_blocker", args: { reason: `dos clientes llamados Ana; clave ${PASSWORD}` } }]);
    expect(r.outcome).toEqual({ kind: "finished", status: "fallida", summary: "La tarea no se pudo completar: dos clientes llamados Ana; clave [redacted]" });
  });

  test("two planner failures in a row end the task", async () => {
    const r = await run(async () => "error");
    expect(r.outcome).toEqual({ kind: "finished", status: "fallida", summary: PLANNER_FAILED_SUMMARY });
    expect(r.planner.cycles).toBe(2);
  });

  test("an unreadable screen three times in a row ends the task before any input", async () => {
    const r = await run(async () => "end", { elements: [] });
    expect(r.outcome).toEqual({ kind: "finished", status: "fallida", summary: OBSERVE_FAILED_SUMMARY });
    expect(r.planner.cycles).toBe(0);
    expect(inputsOf(r.desk.log)).toEqual([]);
  });

  test("a deadline that leaves too little time stops the task before observing or acting", async () => {
    const r = await run(async () => "end", { deadlineInMs: 1_000 });
    expect(r.outcome).toEqual({ kind: "finished", status: "fallida", summary: DEADLINE_SUMMARY });
    expect(r.traces.map((t) => t.kind)).toContain("deadline_reached");
    expect(inputsOf(r.desk.log)).toEqual([]);
    expect(r.planner.cycles).toBe(0);
  });
});

describe("execution cycle and replanning", () => {
  test("a refused action is shown to the next planning cycle, which can replan", async () => {
    const r = await run(
      async (_input, cycle) => {
        if (cycle === 1) return [{ name: "set_plan", args: VERIFY_CONDITIONS }, { name: "click_control", args: { control: "Eliminar" } }];
        return [{ name: "report_blocker", args: { reason: "no encuentro el control" } }];
      },
      { choose: chooseElement("missing") },
    );
    expect(r.outcome.kind).toBe("finished");
    const next = r.planner.seen[1]!.map((entry) => ("text" in entry ? entry.text : "")).join("\n");
    expect(next).toContain("click_control: refused");
    expect(inputsOf(r.desk.log)).toEqual([]);
  });

  test("each cycle starts from a fresh observation after an action", async () => {
    const r = await run(
      async (_input, cycle) => (cycle === 1 ? [{ name: "observe_screen", args: {} }, { name: "press_key", args: { key: "Tab" } }] : [{ name: "report_blocker", args: { reason: "fin" } }]),
    );
    expect(r.outcome.kind).toBe("finished");
    // The loop re-observed before cycle 2: the capture happened after the Tab input.
    const log = r.desk.log;
    const tab = log.indexOf("key:down:65289");
    expect(log.slice(tab).includes("capture")).toBe(true);
  });

  test("long histories are compacted before planning and the instruction stays pinned", async () => {
    const longLabel = "Registro de cliente con datos largos y repetidos ".repeat(3);
    const many: ObservedElement[] = Array.from({ length: 80 }, (_, i) => ({
      id: `e${i}`,
      label: `${longLabel} ${i}`,
      kind: "text" as const,
      value: { state: "text" as const, text: longLabel },
      box: { x: 0, y: 0, w: 1, h: 1 },
      visible: true,
    }));
    const r = await run(async () => [{ name: "observe_screen", args: {} }], { elements: many });
    expect(r.traces.some((t) => t.kind === "compaction")).toBe(true);
    const last = r.planner.seen.at(-1)!;
    expect(last[0]).toEqual({ kind: "user", text: INSTRUCTION, pinned: true });
    expect(transcriptChars(last)).toBeLessThanOrEqual(160_000 + 20_000);
  });
});

describe("recovery after a failed verification", () => {
  test("a partial verdict is followed by steering, a revised plan, and a passing verification", async () => {
    // The first verdict is partial (the unverifiable condition); after the revision it is supported.
    let level = "partial";
    const r = await run(
      async (_input, cycle) => {
        if (cycle === 1) return [{ name: "set_plan", args: { goal: "Contar", completion_conditions: ["El total aparece en pantalla"] } }, { name: "verify_result", args: {} }];
        if (cycle === 2) {
          level = "supported";
          return [{ name: "set_plan", args: { goal: "Contar", completion_conditions: ["La lista filtrada se muestra"] } }, { name: "verify_result", args: {} }];
        }
        return "end";
      },
      { level: () => level },
    );
    expect((r.planner.seen[1]!.at(-1) as { text: string }).text).toContain("Next: act to make the unsupported fact visible");
    expect(r.outcome).toEqual({
      kind: "finished",
      status: "terminada",
      summary: "Tarea completada. Condiciones verificadas: La lista filtrada se muestra.",
    });
    expect(r.planner.cycles).toBe(2);
  });

  test("steering is shown only while verification is failing or stale", () => {
    const state = new TaskRunState();
    expect(nextStepAfterVerification(state)).toBeNull();
    state.setPlan({ goal: "g", steps: [], completionConditions: ["c"] });
    state.verification = { observationId: "o", inputVersion: 0, planVersion: 1, results: [{ condition: "c", level: "partial" }] };
    expect(nextStepAfterVerification(state)).toContain("revise the plan with set_plan");
    state.verification = { observationId: "o", inputVersion: 0, planVersion: 1, results: [{ condition: "c", level: "supported" }] };
    expect(nextStepAfterVerification(state)).toBeNull();
    state.recordInput();
    expect(nextStepAfterVerification(state)).toContain("call verify_result again");
  });
});

describe("the loop verifies when the planner stops", () => {
  const PLAN = { name: "set_plan", args: { goal: "Contar", completion_conditions: ["La lista filtrada se muestra"] } };

  test("a planner that records a plan and stops without verifying is verified by the loop", async () => {
    const r = await run(async (_input, cycle) => (cycle === 1 ? [PLAN] : "end"), { level: "supported" });
    expect(r.outcome).toEqual({
      kind: "finished",
      status: "terminada",
      summary: "Tarea completada. Condiciones verificadas: La lista filtrada se muestra.",
    });
    const verification = r.traces.filter((t) => t.kind === "verification");
    expect(verification).toHaveLength(1);
    expect(verification[0]!.payload).toMatchObject({ source: "loop", status: "ok" });
  });

  test("the loop's verdict is not the planner's claim: unsupported evidence keeps the task open and is shown to the planner", async () => {
    const r = await run(async (_input, cycle) => (cycle === 1 ? [PLAN] : [{ name: "report_blocker", args: { reason: "sin evidencia" } }]), { level: "partial" });
    expect(r.outcome).toEqual({ kind: "finished", status: "fallida", summary: "La tarea no se pudo completar: sin evidencia" });
    const state = (r.planner.seen[1]!.at(-1) as { text: string }).text;
    expect(state).toContain("not passed");
    expect(state).toContain("verify_result (automatic): ok");
  });

  test("two idle turns after failed verification end the task, naming what was not confirmed", async () => {
    const r = await run(async (_input, cycle) => (cycle === 1 ? [PLAN] : "end"), { level: "partial" });
    expect(r.outcome.kind).toBe("finished");
    if (r.outcome.kind !== "finished") return;
    expect(r.outcome.status).toBe("fallida");
    expect(r.outcome.summary).toContain("La lista filtrada se muestra (partial)");
    // Cycle 1 recorded the plan, cycles 2 and 3 were idle. Nothing changed after the first
    // automatic check, so it ran once.
    expect(r.planner.cycles).toBe(3);
    expect(r.traces.filter((t) => t.kind === "verification")).toHaveLength(1);
    expect(r.traces.map((t) => t.kind)).toContain("stalled");
  });

  test("an idle turn followed by real work does not stall the task", async () => {
    const r = await run(
      async (_input, cycle) => {
        if (cycle === 1) return [PLAN];
        if (cycle === 2) return "end";
        return [{ name: "report_blocker", args: { reason: "fin" } }];
      },
      { level: "partial" },
    );
    expect(r.outcome).toEqual({ kind: "finished", status: "fallida", summary: "La tarea no se pudo completar: fin" });
    expect(r.traces.map((t) => t.kind)).not.toContain("stalled");
  });
});
