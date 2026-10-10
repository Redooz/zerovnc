// Planner port: one planning cycle over the task transcript and the tool set. An adapter
// (Pi, in adapters/outbound/pi) runs the model; it holds no task state. The transcript is
// passed in and the new entries come back, so the application owns all task state.
import type { TranscriptEntry } from "../agent/transcript.ts";
import type { ToolSet } from "../tools/contract.ts";
import type { ModelCallEvent } from "./model-call-observer.ts";

export interface PlanCycleInput {
  readonly entries: readonly TranscriptEntry[];
  readonly tools: ToolSet;
  // Aborts at the task deadline or on cancellation. The adapter must stop model requests on abort.
  readonly signal: AbortSignal;
  // Remaining task budget. Model requests use it as their time limit.
  readonly remainingMs: () => number;
  readonly onModelCall: (event: ModelCallEvent) => void;
}

// "action_taken": an acting tool ran, so the loop must observe before the next decision.
// "end_of_turn": the planner stopped without requesting more tools.
export type CycleStop = "action_taken" | "end_of_turn" | "aborted" | "error";

export interface PlanCycleResult {
  // Entries produced by this cycle, to append to the transcript.
  readonly appended: readonly TranscriptEntry[];
  // Last text the planner wrote in this cycle; "" if none.
  readonly text: string;
  readonly stop: CycleStop;
  readonly failure: string | null;
  readonly promptVersion: string;
  readonly toolCalls: number;
}

export interface AgentPlanner {
  runCycle(input: PlanCycleInput): Promise<PlanCycleResult>;
}
