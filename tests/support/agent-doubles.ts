// Test doubles for the agent loop: scripted perception and decision routes, a scripted planner
// that drives the tools directly (no Pi), and a ModelRoutes-shaped stub. No network calls.
import type { ModelRoute } from "../../src/application/models/route.ts";
import type { DecisionOutput, DecisionRequest } from "../../src/application/ports/decision-model.ts";
import type { PerceptionOutput, PerceptionRequest } from "../../src/application/ports/perception-model.ts";
import type { AgentPlanner, PlanCycleInput, PlanCycleResult } from "../../src/application/ports/agent-planner.ts";
import type { ToolResult } from "../../src/application/tools/contract.ts";
import type { ModelRoutes } from "../../src/bootstrap/models.ts";
import type { ObservedElement } from "../../src/domain/perception/observation.ts";
import type { DecisionAnswer } from "../../src/domain/decisions/decision.ts";
import type { ModelCallMetadata } from "../../src/application/ports/perception-model.ts";

export const TEST_ELEMENTS: ObservedElement[] = [
  { id: "save", label: "Guardar", kind: "button", value: { state: "not_applicable" }, box: { x: 0, y: 0, w: 2, h: 2 }, visible: true },
  { id: "name", label: "Nombre", kind: "text_field", value: { state: "text", text: "Ana" }, box: { x: 2, y: 2, w: 2, h: 2 }, visible: true },
];

function metadata(model: string): ModelCallMetadata {
  return {
    model,
    servedBy: model,
    promptVersion: "test.v1",
    promptTokens: 1,
    completionTokens: 1,
    costUsd: 0,
    latencyMs: 1,
  };
}

// Perception route returning a fixed set of elements for any screenshot.
export function perceptionRoute(elements: ObservedElement[] = TEST_ELEMENTS): ModelRoute<PerceptionRequest, PerceptionOutput> {
  return {
    model: "test/perception",
    async call() {
      return { draft: { elements, relations: [], rejectedElements: 0 }, metadata: metadata("test/perception") };
    },
  };
}

// Decision route. `choose` picks the option id for choice questions; `level` answers score questions.
export function decisionRoute(options: { choose?: (request: DecisionRequest) => string; level?: string | (() => string) } = {}): ModelRoute<DecisionRequest, DecisionOutput> {
  return {
    model: "test/decision",
    async call(request) {
      const question = request.question;
      let answer: DecisionAnswer;
      if (question.kind === "score") {
        const level = typeof options.level === "function" ? options.level() : options.level ?? "supported";
        answer = {
          kind: "score",
          questionId: question.id,
          level,
          probabilities: Object.fromEntries(question.levels.map((l) => [l.id, l.id === level ? 1 : 0])),
          confidence: 1,
          evidenceIds: request.evidence.map((e) => e.id),
        };
      } else if (question.kind === "choice") {
        const selected = options.choose?.(request) ?? question.options[0]!.id;
        answer = {
          kind: "choice",
          questionId: question.id,
          selected,
          probabilities: Object.fromEntries(question.options.map((o) => [o.id, o.id === selected ? 1 : 0])),
          confidence: 1,
          evidenceIds: [selected],
        };
      } else {
        throw new Error("boolean questions are not used by the agent loop");
      }
      return { answer, metadata: metadata("test/decision") };
    },
  };
}

// Picks the option whose id is `elementId` (or abstains when it is not offered).
export function chooseElement(elementId: string): (request: DecisionRequest) => string {
  return (request) => {
    const question = request.question;
    if (question.kind !== "choice") return elementId;
    const offered = question.options.find((option) => option.id === elementId);
    return offered?.id ?? "insufficient_evidence";
  };
}

export function stubModels(): ModelRoutes {
  const perception = perceptionRoute();
  const decision = decisionRoute();
  return {
    client: {} as ModelRoutes["client"],
    perceptionPromptVersion: "test.perception.v1",
    perception: { primary: perception, fallback: perception },
    decision: { primary: decision, fallback: decision },
  };
}

export interface ToolCallSpec {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

// Scripted planner: runs the tool calls of each cycle through the ToolSet, in order, and records
// what it was shown. "end" ends the cycle without tools; "error" reports a planner failure.
export class ScriptedPlanner implements AgentPlanner {
  readonly results: ToolResult[][] = [];
  // Transcript the planner received in each cycle.
  readonly seen: PlanCycleInput["entries"][] = [];
  private cycle = 0;

  constructor(private readonly script: (input: PlanCycleInput, cycle: number) => Promise<readonly ToolCallSpec[] | "end" | "error">) {}

  get cycles(): number {
    return this.cycle;
  }

  async runCycle(input: PlanCycleInput): Promise<PlanCycleResult> {
    this.cycle += 1;
    this.seen.push([...input.entries]);
    const plan = await this.script(input, this.cycle);
    if (plan === "error") {
      return { appended: [], text: "", stop: "error", failure: "scripted planner failure", promptVersion: "test.planner.v1", toolCalls: 0 };
    }
    const results: ToolResult[] = [];
    const appended: PlanCycleResult["appended"][number][] = [];
    let stop: PlanCycleResult["stop"] = "end_of_turn";
    if (plan !== "end") {
      for (const [index, call] of plan.entries()) {
        const id = `call-${this.cycle}-${index}`;
        const result = await input.tools.invoke(call.name, call.args, { invocationId: id, signal: input.signal });
        results.push(result);
        appended.push({ kind: "assistant", text: "", toolCalls: [{ id, name: call.name, arguments: call.args }] });
        appended.push({ kind: "tool_result", toolCallId: id, toolName: call.name, status: result.status, text: result.message });
        if (input.tools.shouldEndCycle()) {
          stop = "action_taken";
          break;
        }
      }
    }
    this.results.push(results);
    return { appended, text: "", stop, failure: null, promptVersion: "test.planner.v1", toolCalls: results.length };
  }
}
