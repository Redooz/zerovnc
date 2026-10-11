import { describe, expect, test } from "bun:test";
import { normalizeContext, type Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { PiAgentPlanner, loadPlannerPrompt, PLANNER_MAX_TOKENS } from "../../../src/adapters/outbound/pi/pi-agent-planner.ts";
import { toWireMessages, toWireTools } from "../../../src/adapters/outbound/pi/openrouter-stream.ts";
import { toPiTools } from "../../../src/adapters/outbound/pi/pi-tool-mapper.ts";
import { fromPiMessages, toPiMessages } from "../../../src/adapters/outbound/pi/pi-transcript-mapper.ts";
import type { ToolChatCall, ToolChatReply } from "../../../src/adapters/outbound/openrouter/openrouter-client.ts";
import { ModelCallError } from "../../../src/application/ports/model-call-error.ts";
import type { ModelCallEvent } from "../../../src/application/ports/model-call-observer.ts";
import type { TranscriptEntry } from "../../../src/application/agent/transcript.ts";
import { createTaskToolSet, type DesktopToolDeps } from "../../../src/application/tools/desktop-tools.ts";
import { TaskRunState } from "../../../src/application/tools/run-state.ts";
import { GroundingService } from "../../../src/application/grounding/grounding-service.ts";
import { PerceiveScreen } from "../../../src/application/perception/perceive-screen.ts";
import { decisionRoute, perceptionRoute } from "../../support/agent-doubles.ts";
import { fakeDesktop } from "../../support/fake-desktop.ts";
import type { PlanCycleInput } from "../../../src/application/ports/agent-planner.ts";

function reply(overrides: Partial<ToolChatReply>): ToolChatReply {
  return {
    content: null,
    toolCalls: [],
    finishReason: "stop",
    servedBy: "test/planner",
    promptTokens: 100,
    completionTokens: 20,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: 0.001,
    latencyMs: 5,
    ...overrides,
  };
}

function scriptedClient(replies: Array<ToolChatReply | Error>) {
  const calls: ToolChatCall[] = [];
  return {
    calls,
    client: {
      async completeWithTools(call: ToolChatCall): Promise<ToolChatReply> {
        calls.push(call);
        const next = replies.shift();
        if (next === undefined) throw new Error("no scripted reply left");
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
}

function setup(client: { completeWithTools(call: ToolChatCall): Promise<ToolChatReply> }, fallbackModel: string | null = null) {
  const desk = fakeDesktop({ deadlineInMs: 300_000 });
  const state = new TaskRunState();
  const perception = new PerceiveScreen({ primary: perceptionRoute(), fallback: perceptionRoute(), timeoutMs: 5_000 });
  const decision = decisionRoute();
  const grounding = new GroundingService({ primary: decision, fallback: decision, timeoutMs: 5_000 });
  const deps: DesktopToolDeps = {
    taskId: "task-1",
    executor: desk.executor,
    perception,
    grounding,
    state,
    clock: desk.clock,
    deadlineAt: new Date(desk.clock.now().getTime() + 300_000),
    signal: desk.controller.signal,
  };
  const tools = createTaskToolSet(deps, { now: () => desk.clock.now().getTime(), onInvocation: () => {} });
  const planner = new PiAgentPlanner({
    client,
    primaryModel: "test/planner",
    fallbackModel,
    prompt: { version: "planner.test.v1", text: "SISTEMA DE PRUEBA" },
    cacheBreakpoint: () => false,
    now: () => 1_700_000_000_000,
  });
  return { desk, state, tools, planner };
}

function cycleInput(
  tools: PlanCycleInput["tools"],
  controller: AbortController,
  events: ModelCallEvent[],
  overrides: Partial<PlanCycleInput> = {},
): PlanCycleInput {
  const entries: TranscriptEntry[] = [
    { kind: "user", text: "Tarea: registra a Ana.", pinned: true },
    { kind: "user", text: "Time left: 300 s.\nPlan: none yet." },
  ];
  return {
    entries,
    tools,
    signal: controller.signal,
    remainingMs: () => 250_000,
    onModelCall: (event) => events.push(event),
    ...overrides,
  };
}

describe("PiAgentPlanner", () => {
  test("runs tool calls through the application tool set and returns the new transcript entries", async () => {
    const { client, calls } = scriptedClient([
      reply({ toolCalls: [{ id: "call_1", name: "set_plan", arguments: JSON.stringify({ goal: "Registrar a Ana", completion_conditions: ["Ana aparece"] }) }] }),
      reply({ content: "Hecho. respuesta: 3" }),
    ]);
    const { tools, state, planner } = setup(client);
    const controller = new AbortController();
    const events: ModelCallEvent[] = [];
    tools.beginCycle();
    const result = await planner.runCycle(cycleInput(tools, controller, events));

    expect(state.plan?.goal).toBe("Registrar a Ana");
    expect(result.stop).toBe("end_of_turn");
    expect(result.text).toBe("Hecho. respuesta: 3");
    expect(result.toolCalls).toBe(1);
    expect(result.promptVersion).toBe("planner.test.v1");
    expect(result.appended.map((e) => e.kind)).toEqual(["assistant", "tool_result", "assistant"]);
    expect(result.appended[1]).toMatchObject({ kind: "tool_result", toolName: "set_plan", status: "ok", toolCallId: "call_1" });

    // The model saw the system prompt, the tool declarations, and the state snapshot.
    expect(calls).toHaveLength(2);
    const first = calls[0]!;
    expect(first.messages[0]).toEqual({ role: "system", content: "SISTEMA DE PRUEBA" });
    expect(first.tools.map((t) => t.function.name)).toContain("set_plan");
    expect(first.tools.find((t) => t.function.name === "set_plan")!.function.parameters).toMatchObject({ type: "object" });
    // The second request carries the tool result back with its call id.
    const second = calls[1]!;
    expect(second.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_1" });

    expect(events).toEqual([
      expect.objectContaining({ role: "planner", outcome: "ok", promptVersion: "planner.test.v1", servedBy: "test/planner" }),
      expect.objectContaining({ role: "planner", outcome: "ok" }),
    ]);
  });

  test("an acting tool ends the cycle after its result, with a single model request", async () => {
    const { client, calls } = scriptedClient([reply({ toolCalls: [{ id: "k", name: "press_key", arguments: '{"key":"Tab"}' }] })]);
    const { tools, planner } = setup(client);
    tools.beginCycle();
    const result = await planner.runCycle(cycleInput(tools, new AbortController(), []));
    expect(result.stop).toBe("action_taken");
    expect(calls).toHaveLength(1);
    // Without a fresh observation the key is refused; the refusal is what the next cycle sees.
    expect(result.appended.at(-1)).toMatchObject({ kind: "tool_result", status: "refused" });
  });

  test("malformed tool arguments come back as a readable failed result, not a crash", async () => {
    const { client } = scriptedClient([
      reply({ toolCalls: [{ id: "bad", name: "set_plan", arguments: "{no es json" }] }),
      reply({ content: "Sigo." }),
    ]);
    const { tools, planner } = setup(client);
    tools.beginCycle();
    const result = await planner.runCycle(cycleInput(tools, new AbortController(), []));
    expect(result.appended[1]).toMatchObject({ kind: "tool_result", status: "failed" });
    expect(result.stop).toBe("end_of_turn");
  });

  test("a model failure ends the cycle as an error, with the failure recorded", async () => {
    const { client } = scriptedClient([new ModelCallError("provider", "provider returned HTTP 500")]);
    const { tools, planner } = setup(client);
    const events: ModelCallEvent[] = [];
    tools.beginCycle();
    const result = await planner.runCycle(cycleInput(tools, new AbortController(), events));
    expect(result.stop).toBe("error");
    expect(result.failure).toContain("planner model call failed");
    expect(events).toEqual([expect.objectContaining({ role: "planner", outcome: "failed", failure: "provider" })]);
  });

  test("an eligible primary failure is served by the fallback model, and the switch is recorded", async () => {
    const { client, calls } = scriptedClient([new ModelCallError("timeout", "slow"), reply({ content: "ok", servedBy: "test/fallback" })]);
    const { tools, planner } = setup(client, "test/fallback");
    const events: ModelCallEvent[] = [];
    tools.beginCycle();
    const result = await planner.runCycle(cycleInput(tools, new AbortController(), events));
    expect(result.stop).toBe("end_of_turn");
    expect(calls.map((c) => c.model)).toEqual(["test/planner", "test/fallback"]);
    expect(events[0]).toMatchObject({ servedBy: "test/fallback", fallbackReason: "test/planner: timeout" });
  });

  test("each model request is limited to the remaining task budget", async () => {
    const { client, calls } = scriptedClient([reply({ content: "ok" })]);
    const { tools, planner } = setup(client);
    tools.beginCycle();
    await planner.runCycle(cycleInput(tools, new AbortController(), [], { remainingMs: () => 1_234 }));
    expect(calls[0]!.timeoutMs).toBe(1_234);
  });

  test("aborting the task stops the in-flight model request and reports the cycle as aborted", async () => {
    const hanging = {
      completeWithTools(call: ToolChatCall): Promise<ToolChatReply> {
        return new Promise((_, reject) => {
          call.signal.addEventListener("abort", () => reject(new ModelCallError("cancelled", "request cancelled")), { once: true });
        });
      },
    };
    const { tools, planner } = setup(hanging);
    const controller = new AbortController();
    tools.beginCycle();
    const pending = planner.runCycle(cycleInput(tools, controller, []));
    setTimeout(() => controller.abort(), 10);
    const result = await pending;
    expect(result.stop).toBe("aborted");
  });

  test("the planner prompt file is versioned", () => {
    const prompt = loadPlannerPrompt();
    expect(prompt.version).toBe("planner.v3");
    // A live run truncated replies at an 800-token cap, which surfaced as a malformed reply.
    expect(PLANNER_MAX_TOKENS).toBe(2_000);
    expect(prompt.text).toContain("verify_result");
    expect(prompt.text).toContain("revise the plan with set_plan");
    expect(prompt.text).toContain("Never write a condition about history");
    expect(prompt.text).not.toContain("prompt-version");
  });
});

describe("Pi mapping", () => {
  test("transcript entries survive a round trip through Pi messages, including tool status", () => {
    const entries: TranscriptEntry[] = [
      { kind: "user", text: "estado" },
      { kind: "assistant", text: "pienso", toolCalls: [{ id: "a", name: "click_control", arguments: { control: "Guardar" } }] },
      { kind: "tool_result", toolCallId: "a", toolName: "click_control", status: "refused", text: "stale" },
    ];
    const pi = toPiMessages(entries, "m", () => 1);
    expect(pi.map((m) => m.role)).toEqual(["user", "assistant", "toolResult"]);
    expect(fromPiMessages(pi)).toEqual(entries.slice(1));
  });

  test("Pi tools expose the application schema and map results to content blocks", async () => {
    const { tools } = setup(scriptedClient([]).client);
    tools.beginCycle();
    const piTools = toPiTools(tools);
    const press = piTools.find((t) => t.name === "press_key")!;
    expect(press.executionMode).toBe("sequential");
    const result = await press.execute("call-x", { key: "Tab" } as never, new AbortController().signal);
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(result.details).toEqual({ status: "refused" });
  });

  test("the OpenRouter wire format maps system, user, assistant tool calls, and tool results", () => {
    const tool: Tool = { name: "set_plan", description: "Plan", parameters: Type.Object({ goal: Type.String() }) };
    const context = normalizeContext({
      systemPrompt: "SYS",
      messages: [
        { role: "user", content: "hola", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "t1", name: "set_plan", arguments: { goal: "g" } }],
          api: "openrouter-chat",
          provider: "openrouter",
          model: "m",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: 2,
        },
        { role: "toolResult", toolCallId: "t1", toolName: "set_plan", content: [{ type: "text", text: "listo" }], isError: false, timestamp: 3 },
      ],
      tools: [tool],
    });
    const wire = toWireMessages(context, true);
    expect(wire[0]).toEqual({ role: "system", content: [{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }] });
    expect(wire[1]).toEqual({ role: "user", content: "hola" });
    expect(wire[2]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "t1", type: "function", function: { name: "set_plan", arguments: '{"goal":"g"}' } }],
    });
    expect(wire[3]).toEqual({ role: "tool", tool_call_id: "t1", content: "listo" });
    expect(toWireTools(context)[0]).toMatchObject({ type: "function", function: { name: "set_plan" } });
  });
});
