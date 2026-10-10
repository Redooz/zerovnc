import type { AgentSubmission } from "./fixtures.ts";
import type { AgentOutcome } from "./graders/index.ts";
import type { AppStateEvidence } from "./graders/app-state.ts";

// Evaluator-side ports. Adapters below implement them over HTTP; tests use doubles.
export interface AgentClient {
  submit(submission: AgentSubmission): Promise<string>;
  poll(taskId: string): Promise<AgentOutcome>;
}

export interface DesktopControl {
  reset(): Promise<void>;
  check(practice: unknown): Promise<AppStateEvidence>;
}
