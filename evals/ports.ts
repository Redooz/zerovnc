import type { AgentSubmission } from "./fixtures.ts";
import type { AgentOutcome } from "./graders/index.ts";
import type { AppStateEvidence } from "./graders/app-state.ts";

// Evaluator-side ports. Adapters below implement them over HTTP; tests use doubles.

// Upper bound for one request. The runner passes the remaining task budget so a
// request can never outlive the five-minute limit.
export interface RequestBudget {
  readonly timeoutMs: number;
}

export interface AgentClient {
  submit(submission: AgentSubmission, budget?: RequestBudget): Promise<string>;
  poll(taskId: string, budget?: RequestBudget): Promise<AgentOutcome>;
}

export interface DesktopControl {
  reset(): Promise<void>;
  check(practice: unknown): Promise<AppStateEvidence>;
}
