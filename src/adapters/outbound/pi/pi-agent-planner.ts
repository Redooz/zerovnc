// Planner adapter on Pi (@earendil-works/pi-agent-core). Each planning cycle runs one Pi Agent
// over the application transcript, executes the planner's tool calls through the application
// ToolSet (sequentially), and returns the new transcript entries. It holds no task state: the
// transcript and all decisions stay in the application.
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentPlanner, PlanCycleInput, PlanCycleResult, CycleStop } from "../../../application/ports/agent-planner.ts";
import type { TranscriptEntry } from "../../../application/agent/transcript.ts";
import type { OpenRouterClient } from "../openrouter/openrouter-client.ts";
import type { PromptFile } from "../openrouter/prompt-file.ts";
import { parsePromptFile } from "../openrouter/prompt-file.ts";
import { createOpenRouterStreamFn } from "./openrouter-stream.ts";
import { fromPiMessages, PI_API, PI_PROVIDER, toPiMessages } from "./pi-transcript-mapper.ts";
import { toPiTools } from "./pi-tool-mapper.ts";
import { readFileSync } from "node:fs";

// Planner prompt, versioned like the other prompts. Its version is recorded in each cycle's trace.
export const PLANNER_PROMPT_FILE = "planner.v3.md";
// A planner reply is a tool call or a short summary, and tool arguments can be long. A live run
// showed that an 800-token cap truncated replies mid tool call, which surfaced as a malformed reply
// and failed the task, so the cap is generous again. Idle turns are bounded by the loop's stall stop
// instead of by a token limit.
export const PLANNER_MAX_TOKENS = 2_000;

export function loadPlannerPrompt(): PromptFile {
  return parsePromptFile(readFileSync(new URL(`./prompts/${PLANNER_PROMPT_FILE}`, import.meta.url), "utf8"));
}

export interface PiAgentPlannerOptions {
  readonly client: Pick<OpenRouterClient, "completeWithTools">;
  readonly primaryModel: string;
  readonly fallbackModel: string | null;
  readonly prompt: PromptFile;
  readonly cacheBreakpoint: (model: string) => boolean;
  readonly now?: () => number;
}

export class PiAgentPlanner implements AgentPlanner {
  constructor(private readonly options: PiAgentPlannerOptions) {}

  async runCycle(input: PlanCycleInput): Promise<PlanCycleResult> {
    const { options } = this;
    // Never start a model request on a lease that has already ended.
    if (input.signal.aborted) {
      return { appended: [], text: "", stop: "aborted", failure: null, promptVersion: options.prompt.version, toolCalls: 0 };
    }
    const now = options.now ?? (() => Date.now());
    const streamFn = createOpenRouterStreamFn({
      client: options.client,
      primaryModel: options.primaryModel,
      fallbackModel: options.fallbackModel,
      promptVersion: options.prompt.version,
      maxTokens: PLANNER_MAX_TOKENS,
      remainingMs: input.remainingMs,
      cacheBreakpoint: options.cacheBreakpoint,
      onCall: input.onModelCall,
    });
    const agent = new Agent({
      streamFn,
      initialState: {
        systemPrompt: options.prompt.text,
        model: piModel(options.primaryModel),
        tools: toPiTools(input.tools),
        messages: toPiMessages(input.entries as TranscriptEntry[], options.primaryModel, now) as AgentMessage[],
      },
      toolExecution: "sequential",
      // A tool that acted ends the cycle, so the loop observes before the next decision.
      finishTurn: () => (input.tools.shouldEndCycle() ? { action: "end" } : undefined),
    });

    const start = agent.state.messages.length;
    const onAbort = (): void => agent.abort();
    input.signal.addEventListener("abort", onAbort, { once: true });
    let thrown: string | null = null;
    try {
      await agent.continue();
    } catch (error) {
      thrown = error instanceof Error ? error.name : "unknown";
    } finally {
      input.signal.removeEventListener("abort", onAbort);
    }

    const produced = agent.state.messages.slice(start);
    const appended = fromPiMessages(produced);
    const toolCalls = appended.reduce((count, entry) => count + (entry.kind === "assistant" ? entry.toolCalls.length : 0), 0);
    const text = lastText(appended);
    const errorMessage = agent.state.errorMessage ?? (thrown === null ? null : `planner error (${thrown})`);

    let stop: CycleStop = "end_of_turn";
    let failure: string | null = null;
    if (input.signal.aborted) {
      stop = "aborted";
    } else if (errorMessage !== null) {
      stop = "error";
      failure = errorMessage;
    } else if (input.tools.shouldEndCycle()) {
      stop = "action_taken";
    }
    return { appended, text, stop, failure, promptVersion: options.prompt.version, toolCalls };
  }
}

function lastText(entries: readonly TranscriptEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.kind === "assistant" && entry.text !== "") return entry.text;
  }
  return "";
}

// Pi needs a model description; the request itself goes to the OpenRouter model id.
function piModel(id: string): Model<string> {
  return {
    id,
    name: id,
    api: PI_API,
    provider: PI_PROVIDER,
    baseUrl: "https://openrouter.ai/api/v1",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 200_000,
    maxTokens: PLANNER_MAX_TOKENS,
  };
}
