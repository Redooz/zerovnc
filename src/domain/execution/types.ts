// Execution vocabulary used by later phases. Defined now so that ports, traces,
// and evals share one language. No behavior lives here yet.

import type { TaskId } from "../tasks/task.ts";

// What the agent saw at one moment. Actions reference the observation they used.
export interface Observation {
  readonly id: string;
  readonly taskId: TaskId;
  readonly capturedAt: Date;
  readonly screenshotRef: string | null;
  readonly elements: readonly ObservedElement[];
}

export interface ObservedElement {
  readonly label: string;
  readonly kind: "control" | "field" | "table" | "text" | "icon" | "other";
  readonly value: string | null;
  readonly box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

export type Action =
  | { readonly kind: "click"; readonly x: number; readonly y: number; readonly observationId: string }
  | { readonly kind: "type"; readonly text: string; readonly observationId: string }
  | { readonly kind: "select_all_and_type"; readonly text: string; readonly observationId: string }
  | { readonly kind: "key"; readonly key: string; readonly observationId: string }
  | { readonly kind: "scroll"; readonly delta: number; readonly observationId: string }
  | { readonly kind: "wait"; readonly ms: number; readonly observationId: string }
  | { readonly kind: "screenshot"; readonly observationId: string };

export interface Plan {
  readonly goal: string;
  readonly steps: readonly string[];
  // Explicit, checkable conditions that mean the goal is reached.
  readonly completionConditions: readonly string[];
}

export interface Decision {
  readonly question: string;
  readonly options: readonly string[];
  readonly answer: string;
  readonly confidence: number;
  readonly model: string;
}

export type TraceEventKind =
  | "task_received"
  | "task_started"
  | "desktop_queued"
  | "desktop_acquired"
  | "desktop_expired"
  | "desktop_released"
  | "desktop_connected"
  | "desktop_disconnected"
  | "observation"
  | "plan"
  | "decision"
  | "action"
  | "verification"
  | "cancelled"
  | "deadline_reached"
  | "task_finished"
  | "error";

// One trace event. Every event carries task and span identifiers.
export interface TraceEvent {
  readonly taskId: TaskId;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly kind: TraceEventKind;
  readonly at: Date;
  readonly payload: Readonly<Record<string, unknown>>;
}
