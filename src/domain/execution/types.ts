// Execution vocabulary used by later phases. Defined now so that ports, traces,
// and evals share one language.

import type { TaskId } from "../tasks/task.ts";

// Observation types live in domain/perception/observation.ts; re-exported so
// execution code has one import path.
export type { Observation, ObservedElement } from "../perception/observation.ts";

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
  | "model_call"
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
