import { describe, expect, test } from "bun:test";
import { createDesktopTools, OBSERVATION_RESERVE_MS, SUPPORTED_KEYS, type DesktopToolDeps } from "../../src/application/tools/desktop-tools.ts";
import { keysymsForChord } from "../../src/application/desktop/keysyms.ts";
import { MAX_TOOL_CALLS_PER_CYCLE, ToolSet, type ToolInvocationRecord } from "../../src/application/tools/contract.ts";
import { TaskRunState } from "../../src/application/tools/run-state.ts";
import { GroundingService } from "../../src/application/grounding/grounding-service.ts";
import { PerceiveScreen } from "../../src/application/perception/perceive-screen.ts";
import type { ObservedElement } from "../../src/domain/perception/observation.ts";
import { decisionRoute, chooseElement, perceptionRoute, TEST_ELEMENTS } from "../support/agent-doubles.ts";
import type { DecisionRequest } from "../../src/application/ports/decision-model.ts";
import { fakeDesktop, inputsOf, type FakeDesktop } from "../support/fake-desktop.ts";

const ROW = (id: string, label: string, y: number): ObservedElement => ({
  id,
  label,
  kind: "table_row",
  value: { state: "not_applicable" },
  box: { x: 0, y, w: 8, h: 2 },
  visible: true,
});

interface Harness {
  readonly desk: FakeDesktop;
  readonly state: TaskRunState;
  readonly tools: ToolSet;
  readonly records: ToolInvocationRecord[];
  readonly deps: DesktopToolDeps;
  call(name: string, args?: Record<string, unknown>): Promise<{ status: string; message: string }>;
}

function harness(opts: {
  elements?: ObservedElement[];
  choose?: (request: DecisionRequest) => string;
  level?: string;
  deadlineInMs?: number;
  desk?: FakeDesktop;
} = {}): Harness {
  const desk = opts.desk ?? fakeDesktop({ deadlineInMs: opts.deadlineInMs });
  const state = new TaskRunState();
  const perception = new PerceiveScreen({
    primary: perceptionRoute(opts.elements ?? TEST_ELEMENTS),
    fallback: perceptionRoute(opts.elements ?? TEST_ELEMENTS),
    timeoutMs: 5_000,
  });
  const decision = decisionRoute({ choose: opts.choose, level: opts.level });
  const grounding = new GroundingService({ primary: decision, fallback: decision, timeoutMs: 5_000 });
  const deps: DesktopToolDeps = {
    taskId: "task-1",
    executor: desk.executor,
    perception,
    grounding,
    state,
    clock: desk.clock,
    deadlineAt: new Date(desk.clock.now().getTime() + (opts.deadlineInMs ?? 300_000)),
    signal: desk.controller.signal,
  };
  const records: ToolInvocationRecord[] = [];
  const tools = new ToolSet(createDesktopTools(deps), { now: () => desk.clock.now().getTime(), onInvocation: (r) => records.push(r) });
  let counter = 0;
  return {
    desk,
    state,
    tools,
    records,
    deps,
    async call(name, args = {}) {
      tools.beginCycle();
      const result = await tools.invoke(name, args, { invocationId: `inv-${++counter}`, signal: desk.controller.signal });
      return { status: result.status, message: result.message };
    },
  };
}

describe("freshness and safety of acting tools", () => {
  test("acting tools are refused without a fresh observation and send no input", async () => {
    const h = harness();
    for (const [name, args] of [
      ["click_control", { control: "Guardar" }],
      ["replace_field", { field: "Nombre", text: "Ana" }],
      ["scroll_screen", { direction: "down", steps: 2 }],
      ["press_key", { key: "Tab" }],
    ] as const) {
      expect((await h.call(name, args)).status).toBe("refused");
    }
    expect(inputsOf(h.desk.log)).toEqual([]);
  });

  test("observe_screen makes the observation current, and click_control clicks the control's centre", async () => {
    const h = harness();
    expect((await h.call("observe_screen")).status).toBe("ok");
    expect((await h.call("click_control", { control: "Guardar" })).status).toBe("ok");
    expect(inputsOf(h.desk.log)).toContain("pointer:1@1,1");
    expect(h.records.map((r) => r.tool)).toEqual(["observe_screen", "click_control"]);
  });

  test("any input makes the previous observation stale; the next click is refused", async () => {
    const h = harness();
    await h.call("observe_screen");
    await h.call("click_control", { control: "Guardar" });
    expect(h.state.observation).toBeNull();
    const before = inputsOf(h.desk.log).length;
    expect((await h.call("click_control", { control: "Guardar" })).status).toBe("refused");
    expect(inputsOf(h.desk.log).length).toBe(before);
  });

  test("a control that matches nothing is refused and nothing is clicked", async () => {
    const h = harness({ choose: chooseElement("missing") });
    await h.call("observe_screen");
    const result = await h.call("click_control", { control: "Eliminar" });
    expect(result.status).toBe("refused");
    expect(inputsOf(h.desk.log)).toEqual([]);
  });

  test("two identical controls are refused as ambiguous", async () => {
    const twins: ObservedElement[] = [
      { id: "a", label: "Guardar", kind: "button", value: { state: "not_applicable" }, box: { x: 0, y: 0, w: 2, h: 2 }, visible: true },
      { id: "b", label: "Guardar", kind: "button", value: { state: "not_applicable" }, box: { x: 4, y: 0, w: 2, h: 2 }, visible: true },
    ];
    const h = harness({ elements: twins, choose: chooseElement("a") });
    await h.call("observe_screen");
    const result = await h.call("click_control", { control: "Guardar" });
    expect(result.status).toBe("refused");
    expect(inputsOf(h.desk.log)).toEqual([]);
  });

  test("replace_field clicks the field, selects its text, and types the replacement in one batch", async () => {
    const h = harness();
    await h.call("observe_screen");
    expect((await h.call("replace_field", { field: "Nombre", text: "Ana" })).status).toBe("ok");
    const inputs = inputsOf(h.desk.log);
    expect(inputs[0]).toBe("pointer:1@3,3");
    expect(inputs).toContain("key:down:65507"); // Control held for select-all
    expect(inputs.indexOf("key:down:65507")).toBeLessThan(inputs.indexOf("key:down:65"));
    expect(h.state.inputVersion).toBe(1);
  });
});

describe("disabled controls", () => {
  const disabledSave: ObservedElement = { ...TEST_ELEMENTS[0]!, disabled: true };
  const disabledName: ObservedElement = { ...TEST_ELEMENTS[1]!, disabled: true };

  test("click_control refuses a disabled control and sends no input", async () => {
    const h = harness({ elements: [disabledSave, TEST_ELEMENTS[1]!] });
    await h.call("observe_screen");
    const result = await h.call("click_control", { control: "Guardar" });
    expect(result.status).toBe("refused");
    expect(result.message).toContain("disabled");
    expect(inputsOf(h.desk.log)).toEqual([]);
  });

  test("replace_field refuses a disabled field and sends no input", async () => {
    const h = harness({ elements: [TEST_ELEMENTS[0]!, disabledName], choose: chooseElement("name") });
    await h.call("observe_screen");
    expect((await h.call("replace_field", { field: "Nombre", text: "Ana" })).status).toBe("refused");
    expect(inputsOf(h.desk.log)).toEqual([]);
  });

  test("the verifier sees a disabled control as disabled", async () => {
    const seen: string[] = [];
    const h = harness({ elements: [disabledSave] });
    const original = h.deps.grounding.scoreTransition.bind(h.deps.grounding);
    h.deps.grounding.scoreTransition = (input) => {
      seen.push(...input.observation.elements.map((e) => `${e.label}:${e.disabled === true}`));
      return original(input);
    };
    await h.call("set_plan", { goal: "g", completion_conditions: ["Guardar is disabled"] });
    await h.call("verify_result");
    expect(seen).toEqual(["Guardar:true"]);
  });
});

describe("records", () => {
  test("select_record refuses when several rows match and clicks the only match", async () => {
    const twoAna = [ROW("r1", "Ana Torres Pérez", 0), ROW("r2", "Ana Torres Ruiz", 4)];
    const dup = harness({ elements: twoAna });
    await dup.call("observe_screen");
    expect((await dup.call("select_record", { identity: "Ana Torres" })).status).toBe("refused");
    expect(inputsOf(dup.desk.log)).toEqual([]);

    const one = harness({ elements: [ROW("r1", "Ana Torres Pérez", 0), ROW("r2", "Luis Mora", 4)] });
    await one.call("observe_screen");
    expect((await one.call("select_record", { identity: "Ana Torres" })).status).toBe("ok");
    expect(inputsOf(one.desk.log)).toContain("pointer:1@4,1");
  });

  test("select_record matches whole words only", async () => {
    const h = harness({ elements: [ROW("r1", "Anabel Torresol", 0)] });
    await h.call("observe_screen");
    expect((await h.call("select_record", { identity: "Ana Torres" })).status).toBe("refused");
  });
});

describe("keys, scrolling, and waiting", () => {
  test("every advertised key maps to a keysym", () => {
    for (const key of SUPPORTED_KEYS) expect(keysymsForChord(key)).not.toBeNull();
  });

  test("press_key refuses keys outside the allowlist before anything reaches the desktop", async () => {
    const h = harness();
    await h.call("observe_screen");
    const result = await h.call("press_key", { key: "ctrl+q" });
    expect(result.status).toBe("failed");
    expect(inputsOf(h.desk.log)).toEqual([]);
  });

  test("press_key sends an allowed key after a fresh observation", async () => {
    const h = harness();
    await h.call("observe_screen");
    expect((await h.call("press_key", { key: "Tab" })).status).toBe("ok");
    expect(inputsOf(h.desk.log)).toEqual(["key:down:65289", "key:up:65289"]);
  });

  test("scroll_screen is bounded and invalidates the observation", async () => {
    const h = harness();
    await h.call("observe_screen");
    expect((await h.call("scroll_screen", { direction: "down", steps: 11 })).status).toBe("failed");
    expect(inputsOf(h.desk.log)).toEqual([]);
    expect((await h.call("scroll_screen", { direction: "down", steps: 2 })).status).toBe("ok");
    expect(h.state.observation).toBeNull();
    expect(inputsOf(h.desk.log).length).toBe(4);
  });

  test("wait_for_screen is refused when the remaining budget cannot cover the screen read", async () => {
    const h = harness({ deadlineInMs: OBSERVATION_RESERVE_MS - 1_000 });
    const captures = h.desk.log.filter((entry) => entry === "capture").length;
    expect((await h.call("wait_for_screen", { ms: 500 })).status).toBe("refused");
    expect(h.desk.log.filter((entry) => entry === "capture").length).toBe(captures);
  });

  test("wait_for_screen waits, then takes a fresh observation", async () => {
    const h = harness({ deadlineInMs: 120_000 });
    expect((await h.call("wait_for_screen", { ms: 300 })).status).toBe("ok");
    expect(h.state.observation).not.toBeNull();
    expect(h.desk.log).toContain("capture");
  });
});

describe("plan, verification, and blockers", () => {
  test("verify_result needs a plan", async () => {
    const h = harness();
    expect((await h.call("verify_result")).status).toBe("refused");
  });

  test("verification passes only when every condition is supported and no input followed it", async () => {
    const h = harness({ level: "supported" });
    await h.call("set_plan", { goal: "Guardar cliente", completion_conditions: ["Guardar is visible", "Nombre shows Ana"] });
    expect((await h.call("verify_result")).status).toBe("ok");
    expect(h.state.verificationPassed()).toBe(true);

    await h.call("observe_screen");
    await h.call("click_control", { control: "Guardar" });
    expect(h.state.verificationPassed()).toBe(false);
  });

  test("unsupported conditions are reported as evidence and do not pass", async () => {
    const h = harness({ level: "not_supported" });
    await h.call("set_plan", { goal: "Guardar", completion_conditions: ["Ana appears"] });
    const result = await h.call("verify_result");
    expect(result.status).toBe("ok");
    expect(result.message).toContain("not_supported");
    expect(h.state.verificationPassed()).toBe(false);
  });

  test("a plan change makes an earlier verification stale", async () => {
    const h = harness({ level: "supported" });
    await h.call("set_plan", { goal: "A", completion_conditions: ["Guardar is visible"] });
    await h.call("verify_result");
    await h.call("set_plan", { goal: "B", completion_conditions: ["Guardar is visible"] });
    expect(h.state.verificationPassed()).toBe(false);
  });

  test("report_blocker records the reason", async () => {
    const h = harness();
    expect((await h.call("report_blocker", { reason: "dos registros con el mismo nombre" })).status).toBe("ok");
    expect(h.state.blocker).toBe("dos registros con el mismo nombre");
  });
});

describe("tool set contract", () => {
  test("unknown tools and invalid input fail without running anything", async () => {
    const h = harness();
    expect((await h.call("delete_everything")).status).toBe("failed");
    expect((await h.call("set_plan", { goal: "" })).status).toBe("failed");
    expect(h.state.plan).toBeNull();
  });

  test("a cycle allows a bounded number of calls, then refuses", async () => {
    const h = harness();
    h.tools.beginCycle();
    for (let i = 0; i < MAX_TOOL_CALLS_PER_CYCLE; i++) {
      const result = await h.tools.invoke("set_plan", { goal: "g", completion_conditions: ["c"] }, { invocationId: `x${i}`, signal: h.desk.controller.signal });
      expect(result.status).toBe("ok");
    }
    const over = await h.tools.invoke("set_plan", { goal: "g", completion_conditions: ["c"] }, { invocationId: "over", signal: h.desk.controller.signal });
    expect(over.status).toBe("refused");
  });

  test("an acting tool ends the cycle, and non-acting tools do not", async () => {
    const h = harness();
    await h.call("observe_screen");
    h.tools.beginCycle();
    await h.tools.invoke("set_plan", { goal: "g", completion_conditions: ["c"] }, { invocationId: "p", signal: h.desk.controller.signal });
    expect(h.tools.shouldEndCycle()).toBe(false);
    await h.tools.invoke("click_control", { control: "Guardar" }, { invocationId: "c", signal: h.desk.controller.signal });
    expect(h.tools.shouldEndCycle()).toBe(true);
  });

  test("every invocation is traced with its tool name, invocation id, and version", async () => {
    const h = harness();
    await h.call("observe_screen");
    const last = h.records[h.records.length - 1]!;
    expect(last.tool).toBe("observe_screen");
    expect(last.invocationId).toMatch(/^inv-/);
    expect(last.version).toBe("v1");
    expect(last.status).toBe("ok");
  });

  test("descriptors expose JSON Schema parameters and the acting flag", () => {
    const h = harness();
    const descriptors = h.tools.descriptors();
    const click = descriptors.find((d) => d.name === "click_control")!;
    expect(click.acts).toBe(true);
    expect(click.parameters).toMatchObject({ type: "object" });
    expect(descriptors.map((d) => d.name)).toEqual(
      expect.arrayContaining(["observe_screen", "click_control", "select_record", "replace_field", "scroll_screen", "press_key", "wait_for_screen", "verify_result", "set_plan", "report_blocker"]),
    );
  });
});
