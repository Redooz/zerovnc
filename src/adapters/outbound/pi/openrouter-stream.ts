// Pi stream function backed by OpenRouter chat completions with tool declarations. Pi reads the
// transcript (system prompt, tool declarations, messages); this adapter maps it to the wire
// format, makes one request per model turn, and reports the reply as Pi stream events.
// Requests stop at the caller's abort signal and never outlive the remaining task budget.
// Failures are encoded in the stream (never thrown), as the Pi StreamFn contract requires.
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type AssistantMessage,
  type AssistantMessageEvent,
  type ImageContent,
  type Message,
  type TextContent,
  type ToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { ModelCallError, isFallbackEligible } from "../../../application/ports/model-call-error.ts";
import type { ModelCallEvent } from "../../../application/ports/model-call-observer.ts";
import type { OpenRouterClient, ToolChatCall, WireMessage, WireTool } from "../openrouter/openrouter-client.ts";
import { PI_API, PI_PROVIDER, zeroUsage } from "./pi-transcript-mapper.ts";

export interface OpenRouterStreamOptions {
  readonly client: Pick<OpenRouterClient, "completeWithTools">;
  // Primary model first; the fallback is tried once on an eligible failure.
  readonly primaryModel: string;
  readonly fallbackModel: string | null;
  readonly promptVersion: string;
  readonly maxTokens: number;
  // Remaining task budget; each request's time limit is capped by it.
  readonly remainingMs: () => number;
  readonly cacheBreakpoint: (model: string) => boolean;
  readonly onCall: (event: ModelCallEvent) => void;
}

// Maps Pi transcript messages to OpenAI-style wire messages. A non-leading system message is
// folded into the prompt by Pi (getCurrentSystemPrompt), so only user, assistant, and tool
// messages are mapped here.
export function toWireMessages(context: TranscriptContext, cacheBreakpoint: boolean): WireMessage[] {
  const out: WireMessage[] = [];
  const system = getCurrentSystemPrompt(context.messages);
  if (system !== "") {
    out.push({
      role: "system",
      content: cacheBreakpoint ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] : system,
    });
  }
  for (const message of context.messages as readonly Message[]) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      out.push({ role: "user", content: typeof message.content === "string" ? message.content : textOf(message.content) });
    } else if (message.role === "assistant") {
      const text = textOf(message.content.filter((part): part is TextContent => part.type === "text"));
      const calls = message.content.filter((part): part is ToolCall => part.type === "toolCall");
      out.push({
        role: "assistant",
        content: text === "" ? null : text,
        ...(calls.length > 0
          ? { tool_calls: calls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }
          : {}),
      });
    } else if (message.role === "toolResult") {
      out.push({ role: "tool", tool_call_id: message.toolCallId, content: textOf(message.content) });
    }
  }
  return out;
}

export function toWireTools(context: TranscriptContext): WireTool[] {
  return getCurrentTools(context.messages).map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters as Record<string, unknown> },
  }));
}

// Text parts only; images are not sent (the planner reads text state).
function textOf(parts: readonly (TextContent | ImageContent)[]): string {
  return parts
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function createOpenRouterStreamFn(options: OpenRouterStreamOptions): StreamFn {
  return (model, context, streamOptions) => {
    const stream = createAssistantMessageEventStream();
    void drive(options, model.id, context, streamOptions?.signal, stream);
    return stream;
  };
}

async function drive(
  options: OpenRouterStreamOptions,
  requestedModel: string,
  context: TranscriptContext,
  callerSignal: AbortSignal | undefined,
  stream: ReturnType<typeof createAssistantMessageEventStream>,
): Promise<void> {
  const signal = callerSignal ?? new AbortController().signal;
  const partial: AssistantMessage = {
    role: "assistant",
    content: [],
    api: PI_API,
    provider: PI_PROVIDER,
    model: options.primaryModel,
    usage: zeroUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
  const push = (event: AssistantMessageEvent): void => stream.push(event);
  push({ type: "start", partial });

  let servedBy: string = options.primaryModel;
  let fallbackReason: string | null = null;
  try {
    const attempt = (model: string): Promise<Awaited<ReturnType<OpenRouterClient["completeWithTools"]>>> => {
      const call: ToolChatCall = {
        model,
        messages: toWireMessages(context, options.cacheBreakpoint(model)),
        tools: toWireTools(context),
        signal,
        timeoutMs: Math.max(1, options.remainingMs()),
        maxTokens: options.maxTokens,
      };
      return options.client.completeWithTools(call);
    };
    let reply;
    try {
      reply = await attempt(options.primaryModel);
    } catch (error) {
      if (!isFallbackEligible(error) || signal.aborted || options.fallbackModel === null) throw error;
      fallbackReason = `${options.primaryModel}: ${error.kind}`;
      servedBy = options.fallbackModel;
      reply = await attempt(options.fallbackModel);
    }
    servedBy = reply.servedBy;

    if (reply.content !== null) {
      const index = partial.content.length;
      const text: TextContent = { type: "text", text: "" };
      partial.content.push(text);
      push({ type: "text_start", contentIndex: index, partial });
      text.text = reply.content;
      push({ type: "text_delta", contentIndex: index, delta: reply.content, partial });
      push({ type: "text_end", contentIndex: index, content: reply.content, partial });
    }
    for (const call of reply.toolCalls) {
      const index = partial.content.length;
      const args = parseArguments(call.arguments);
      const toolCall: ToolCall = { type: "toolCall", id: call.id, name: call.name, arguments: args };
      partial.content.push(toolCall);
      push({ type: "toolcall_start", contentIndex: index, partial });
      push({ type: "toolcall_delta", contentIndex: index, delta: call.arguments, partial });
      push({ type: "toolcall_end", contentIndex: index, toolCall, partial });
    }

    partial.usage = {
      input: reply.promptTokens ?? 0,
      output: reply.completionTokens ?? 0,
      cacheRead: reply.cacheReadTokens ?? 0,
      cacheWrite: reply.cacheWriteTokens ?? 0,
      totalTokens: (reply.promptTokens ?? 0) + (reply.completionTokens ?? 0),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: reply.costUsd ?? 0 },
    };
    partial.model = servedBy;
    partial.stopReason = reply.toolCalls.length > 0 ? "toolUse" : reply.finishReason === "length" ? "length" : "stop";
    options.onCall(callEvent(options, requestedModel, servedBy, fallbackReason, reply));
    push({
      type: "done",
      reason: partial.stopReason === "length" ? "length" : partial.stopReason === "toolUse" ? "toolUse" : "stop",
      message: partial,
    });
  } catch (error) {
    const kind = error instanceof ModelCallError ? error.kind : "unexpected";
    const aborted = signal.aborted;
    const failure: AssistantMessage = {
      ...partial,
      stopReason: aborted ? "aborted" : "error",
      errorMessage: aborted ? "request cancelled" : `planner model call failed (${kind})`,
    };
    options.onCall(failureEvent(options, requestedModel, fallbackReason, kind));
    push({ type: "error", reason: aborted ? "aborted" : "error", error: failure });
  }
}

function parseArguments(raw: string): ToolCall["arguments"] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as ToolCall["arguments"];
  } catch {
    // Fall through: the tool layer rejects the raw text with a validation error the model can read.
  }
  return { _raw: raw };
}

function callEvent(
  options: OpenRouterStreamOptions,
  configuredModel: string,
  servedBy: string,
  fallbackReason: string | null,
  reply: { promptTokens: number | null; completionTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null; costUsd: number | null; latencyMs: number },
): ModelCallEvent {
  return {
    role: "planner",
    observationId: null,
    questionId: null,
    configuredModel,
    servedBy,
    promptVersion: options.promptVersion,
    fallbackReason,
    promptTokens: reply.promptTokens,
    completionTokens: reply.completionTokens,
    cacheReadTokens: reply.cacheReadTokens,
    cacheWriteTokens: reply.cacheWriteTokens,
    costUsd: reply.costUsd,
    latencyMs: reply.latencyMs,
    outcome: "ok",
    failure: null,
  };
}

function failureEvent(options: OpenRouterStreamOptions, configuredModel: string, fallbackReason: string | null, failure: string): ModelCallEvent {
  return {
    role: "planner",
    observationId: null,
    questionId: null,
    configuredModel,
    servedBy: null,
    promptVersion: options.promptVersion,
    fallbackReason,
    promptTokens: null,
    completionTokens: null,
    costUsd: null,
    latencyMs: null,
    outcome: "failed",
    failure,
  };
}
