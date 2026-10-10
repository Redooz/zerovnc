import { z } from "zod";
import type { AgentSubmission } from "../fixtures.ts";
import type { AgentOutcome } from "../graders/index.ts";
import type { AgentClient } from "../ports.ts";

const TaskAcceptedSchema = z.object({ task_id: z.string().min(1) });
const TaskStatusSchema = z.object({ estado: z.string(), resumen: z.string() });

// Talks to the agent under test through the public API only.
export class HttpAgentClient implements AgentClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async submit(submission: AgentSubmission): Promise<string> {
    const response = await fetch(new URL("/tasks", this.baseUrl), {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(submission),
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

  async poll(taskId: string): Promise<AgentOutcome> {
    const response = await fetch(new URL(`/tasks/${encodeURIComponent(taskId)}`, this.baseUrl), {
      headers: this.headers(),
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

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, ...extra };
  }
}
