import { z } from "zod";
import type { AgentSubmission } from "../fixtures.ts";
import type { AgentOutcome } from "../graders/index.ts";
import type { AgentClient, RequestBudget } from "../ports.ts";

const TaskAcceptedSchema = z.object({ task_id: z.string().min(1) });
const TaskStatusSchema = z.object({ estado: z.string(), resumen: z.string() });

// Talks to the agent under test through the public API only.
export class HttpAgentClient implements AgentClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    // Every request is bounded so a stalled agent cannot hold the runner past its deadline.
    private readonly requestTimeoutMs: number = 10_000,
  ) {}

  async submit(submission: AgentSubmission, budget?: RequestBudget): Promise<string> {
    const response = await fetch(new URL("/tasks", this.baseUrl), {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(submission),
      signal: AbortSignal.timeout(this.limit(budget)),
    });
    if (!response.ok) {
      throw new Error(`POST /tasks failed with status ${response.status}`);
    }
    const parsed = TaskAcceptedSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error("POST /tasks returned an unexpected body");
    }
    return parsed.data.task_id;
  }

  async poll(taskId: string, budget?: RequestBudget): Promise<AgentOutcome> {
    const response = await fetch(new URL(`/tasks/${encodeURIComponent(taskId)}`, this.baseUrl), {
      headers: this.headers(),
      signal: AbortSignal.timeout(this.limit(budget)),
    });
    if (!response.ok) {
      throw new Error(`GET /tasks/${taskId} failed with status ${response.status}`);
    }
    const parsed = TaskStatusSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error("GET /tasks/{id} returned an unexpected body");
    }
    return parsed.data;
  }

  // The smaller of the fixed request timeout and the caller's remaining budget.
  private limit(budget: RequestBudget | undefined): number {
    const remaining = budget?.timeoutMs ?? Number.POSITIVE_INFINITY;
    if (remaining <= 0) {
      throw new Error("request budget exhausted");
    }
    return Math.min(this.requestTimeoutMs, remaining);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, ...extra };
  }
}
