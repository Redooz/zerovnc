// Provider-neutral tool contract for the planner. A tool has a name, model-facing
// description, zod input schema, and an application-typed result. Pi content blocks and
// TypeBox types live only in the Pi adapter (pi-tool-mapper). Tools are application
// services: they run sequentially, validate their input before doing anything, and
// enforce the safety rules themselves, so they hold no matter which planner calls them.
import { z } from "zod";

export type ToolStatus = "ok" | "refused" | "failed";

export interface ToolResult {
  readonly status: ToolStatus;
  // Model-facing text. Never contains secrets: the desktop password is not known here.
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>>;
  // The UI target this acted on, as a label only ("Clientes", "Nombre"). Set by tools that ground
  // a control or field, so a verified task can be reduced to a reusable procedure. Never a value,
  // a record identity, or typed text.
  readonly subject?: string;
}

export interface ToolCallContext {
  readonly invocationId: string;
  readonly signal: AbortSignal;
}

export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  readonly name: string;
  // Version of the name and description. Recorded in traces.
  readonly version: string;
  // Model-facing prompt text.
  readonly description: string;
  readonly input: S;
  // Acting tools send desktop input. The planning cycle ends after one, so the next
  // decision is made from a fresh observation.
  readonly acts: boolean;
  run(input: z.output<S>, call: ToolCallContext): Promise<ToolResult>;
}

// Provider-neutral view of a tool, for the planner adapter to map.
export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly acts: boolean;
}

export interface ToolInvocationRecord {
  readonly tool: string;
  readonly invocationId: string;
  readonly version: string;
  readonly status: ToolStatus;
  readonly message: string;
  readonly reason: string | null;
  readonly durationMs: number;
  // UI target label, when the tool acted on one.
  readonly subject?: string;
}

export interface ToolSetOptions {
  readonly onInvocation: (record: ToolInvocationRecord) => void;
  readonly now: () => number;
}

export const MAX_TOOL_CALLS_PER_CYCLE = 6;

// The tools offered to one task. Built per task by a factory, so nothing is shared across tasks.
export class ToolSet {
  private readonly byName: Map<string, ToolDefinition>;
  private callsThisCycle = 0;
  private cycleEnded = false;

  constructor(
    tools: readonly ToolDefinition[],
    private readonly options: ToolSetOptions,
  ) {
    this.byName = new Map();
    for (const tool of tools) {
      if (this.byName.has(tool.name)) throw new Error(`duplicate tool name: ${tool.name}`);
      this.byName.set(tool.name, tool);
    }
  }

  // Version string covering every name and description; recorded once per task.
  get version(): string {
    return [...this.byName.values()].map((tool) => `${tool.name}@${tool.version}`).join(",");
  }

  descriptors(): ToolDescriptor[] {
    return [...this.byName.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      // Input side: fields with defaults are optional for the caller.
      parameters: z.toJSONSchema(tool.input, { io: "input" }) as Record<string, unknown>,
      acts: tool.acts,
    }));
  }

  // Starts a planning cycle: resets the per-cycle call budget and end marker.
  beginCycle(): void {
    this.callsThisCycle = 0;
    this.cycleEnded = false;
  }

  // True after an acting tool ran in this cycle; the planner must stop and let the loop observe.
  shouldEndCycle(): boolean {
    return this.cycleEnded;
  }

  async invoke(name: string, rawArgs: unknown, call: ToolCallContext): Promise<ToolResult> {
    const started = this.options.now();
    const tool = this.byName.get(name);
    const finish = (result: ToolResult, reason: string | null): ToolResult => {
      this.options.onInvocation({
        tool: name,
        invocationId: call.invocationId,
        version: tool?.version ?? "unknown",
        status: result.status,
        message: result.message,
        reason,
        ...(result.subject === undefined ? {} : { subject: result.subject }),
        durationMs: this.options.now() - started,
      });
      return result;
    };
    if (tool === undefined) {
      return finish({ status: "failed", message: `unknown tool "${name}"` }, "unknown tool");
    }
    if (this.callsThisCycle >= MAX_TOOL_CALLS_PER_CYCLE) {
      return finish(
        { status: "refused", message: "tool call budget for this step is used up; the next step starts from a fresh observation" },
        "cycle budget",
      );
    }
    this.callsThisCycle += 1;

    const parsed = tool.input.safeParse(rawArgs);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
      return finish({ status: "failed", message: `invalid input for ${name}: ${issues}` }, "invalid input");
    }
    if (call.signal.aborted) {
      return finish({ status: "refused", message: "the task is stopping; no action was taken" }, "aborted");
    }

    let result: ToolResult;
    try {
      result = await tool.run(parsed.data, call);
    } catch (error) {
      // Tool errors are reported to the planner without the underlying message, which may
      // contain connection details.
      const kind = error instanceof Error ? error.name : "unknown";
      return finish({ status: "failed", message: `${name} failed unexpectedly (${kind})` }, `error: ${kind}`);
    }
    if (tool.acts) this.cycleEnded = true;
    return finish(result, result.status === "ok" ? null : result.message);
  }
}
