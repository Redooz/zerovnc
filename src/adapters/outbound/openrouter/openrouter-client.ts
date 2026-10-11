// Thin OpenRouter client for two endpoints:
//   chat completions (perception, vision models) under the /api/v1 base URL, and
//   the Decisions API (decision models such as jev-latest), which lives at /api/alpha/decisions.
// Every failure is mapped to ModelCallError. Error messages never include the API
// key, the request body, or the response body.
import { ModelCallError } from "../../../application/ports/model-call-error.ts";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_DECISIONS_PATH = "/api/alpha/decisions";

export type ContentPart =
  // cache_control marks a provider cache breakpoint: everything up to and including this
  // part may be cached (Anthropic-style explicit caching).
  | { readonly type: "text"; readonly text: string; readonly cache_control?: { readonly type: "ephemeral" } }
  | { readonly type: "image_url"; readonly image_url: { readonly url: string } };

export interface ChatMessage {
  readonly role: "system" | "user";
  readonly content: string | readonly ContentPart[];
}

export interface ChatCall {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxTokens: number;
}

export interface ChatReply {
  readonly content: string;
  // Why generation stopped: "length" means the reply hit the token limit and is cut off.
  readonly finishReason: string | null;
  readonly servedBy: string;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  // Provider cache usage as reported (null when the route reports none).
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly costUsd: number | null;
  readonly latencyMs: number;
}

// Decisions API request: one state (text) and one or more typed questions.
export interface DecisionQuestionWire {
  readonly type: "choice" | "score";
  readonly question: string;
  readonly instructions: string;
  // choice: option id -> label. score: ordered level labels.
  readonly criteria: Readonly<Record<string, string>> | readonly string[];
}

export interface DecisionsCall {
  readonly model: string;
  // Text, or parts with text and image_url entries (verified against the live API).
  readonly state: string | readonly ContentPart[];
  readonly questions: Readonly<Record<string, DecisionQuestionWire>>;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

// Wire shapes for tool-calling chat completions (OpenAI-compatible).
export type WireMessage =
  | { readonly role: "system"; readonly content: string | readonly ContentPart[] }
  | { readonly role: "user"; readonly content: string | readonly ContentPart[] }
  | {
      readonly role: "assistant";
      readonly content: string | null;
      readonly tool_calls?: readonly { readonly id: string; readonly type: "function"; readonly function: { readonly name: string; readonly arguments: string } }[];
    }
  | { readonly role: "tool"; readonly tool_call_id: string; readonly content: string };

export interface WireTool {
  readonly type: "function";
  readonly function: { readonly name: string; readonly description: string; readonly parameters: Record<string, unknown> };
}

export interface ToolChatCall {
  readonly model: string;
  readonly messages: readonly WireMessage[];
  readonly tools: readonly WireTool[];
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxTokens: number;
}

export interface ToolChatReply {
  readonly content: string | null;
  readonly toolCalls: readonly { readonly id: string; readonly name: string; readonly arguments: string }[];
  readonly finishReason: string | null;
  readonly servedBy: string;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly costUsd: number | null;
  readonly latencyMs: number;
}

export interface DecisionsReply {
  readonly answers: Readonly<Record<string, unknown>>;
  readonly servedBy: string;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly costUsd: number | null;
  readonly latencyMs: number;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class OpenRouterClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = OPENROUTER_BASE_URL,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly now: () => number = () => performance.now(),
    // OpenRouter provider routing for chat completions: "throughput" asks for the fastest provider
    // of the same model. Null keeps OpenRouter's default load balancing.
    private readonly providerSort: "throughput" | "latency" | "price" | null = null,
  ) {}

  private routing(): { provider: { sort: string } } | Record<string, never> {
    return this.providerSort === null ? {} : { provider: { sort: this.providerSort } };
  }

  async complete(call: ChatCall): Promise<ChatReply> {
    const started = this.now();
    const body = await this.post(
      `${this.baseUrl.replace(/\/+$/, "")}/chat/completions`,
      {
        model: call.model,
        messages: call.messages,
        max_tokens: call.maxTokens,
        temperature: 0,
        usage: { include: true },
        ...this.routing(),
      },
      call,
    );
    return parseChatBody(body, call.model, Math.round(this.now() - started));
  }

  // Chat completion with tool declarations (planner). Tool-call arguments come back as the raw JSON
  // string the model wrote; the caller validates them.
  async completeWithTools(call: ToolChatCall): Promise<ToolChatReply> {
    const started = this.now();
    const body = await this.post(
      `${this.baseUrl.replace(/\/+$/, "")}/chat/completions`,
      {
        model: call.model,
        messages: call.messages,
        tools: call.tools,
        tool_choice: "auto",
        max_tokens: call.maxTokens,
        temperature: 0,
        usage: { include: true },
        ...this.routing(),
      },
      call,
    );
    return parseToolChatBody(body, call.model, Math.round(this.now() - started));
  }

  async decide(call: DecisionsCall): Promise<DecisionsReply> {
    const started = this.now();
    const body = await this.post(
      new URL(OPENROUTER_DECISIONS_PATH, new URL(this.baseUrl).origin).toString(),
      { model: call.model, state: call.state, questions: call.questions },
      call,
    );
    return parseDecisionsBody(body, call.model, Math.round(this.now() - started));
  }

  // Sends one JSON POST. Maps transport, HTTP, and parse failures to ModelCallError.
  private async post(
    url: string,
    payload: unknown,
    call: { readonly signal: AbortSignal; readonly timeoutMs: number },
  ): Promise<unknown> {
    if (call.signal.aborted) throw new ModelCallError("cancelled", "request cancelled before sending");
    const timer = AbortSignal.timeout(call.timeoutMs);
    const signal = AbortSignal.any([call.signal, timer]);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal,
      });
    } catch {
      throw classifyAbort(call.signal, timer, "transport error", true);
    }

    if (!response.ok) {
      // Server errors, rate limits, and request timeouts may clear on a second attempt.
      const retryable = response.status >= 500 || response.status === 429 || response.status === 408;
      throw new ModelCallError("provider", `provider returned HTTP ${response.status}`, retryable);
    }
    try {
      return await response.json();
    } catch {
      throw classifyAbort(call.signal, timer, "provider response was not JSON");
    }
  }
}

function classifyAbort(callerSignal: AbortSignal, timer: AbortSignal, otherwise: string, retryable = false): ModelCallError {
  if (callerSignal.aborted) return new ModelCallError("cancelled", "request cancelled");
  if (timer.aborted) return new ModelCallError("timeout", "request exceeded its time limit");
  return new ModelCallError("provider", otherwise, retryable);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ModelCallError("malformed", `${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Accepts only the fields we use; anything else is ignored.
function parseChatBody(body: unknown, requestedModel: string, latencyMs: number): ChatReply {
  const record = asRecord(body, "provider body");
  const choices = record.choices;
  const first = Array.isArray(choices) ? (choices[0] as Record<string, unknown> | undefined) : undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new ModelCallError("malformed", "provider returned no text content");
  }
  const usage = (record.usage ?? {}) as Record<string, unknown>;
  const details = (usage.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const servedBy = typeof record.model === "string" && record.model !== "" ? record.model : requestedModel;
  return {
    content,
    finishReason: typeof first?.finish_reason === "string" ? first.finish_reason : null,
    servedBy,
    promptTokens: numberOrNull(usage.prompt_tokens),
    completionTokens: numberOrNull(usage.completion_tokens),
    cacheReadTokens: numberOrNull(details.cached_tokens),
    cacheWriteTokens: numberOrNull(details.cache_write_tokens),
    costUsd: numberOrNull(usage.cost),
    latencyMs,
  };
}

function parseToolChatBody(body: unknown, requestedModel: string, latencyMs: number): ToolChatReply {
  const record = asRecord(body, "provider body");
  const choices = record.choices;
  const first = Array.isArray(choices) ? (choices[0] as Record<string, unknown> | undefined) : undefined;
  const message = (first?.message ?? undefined) as Record<string, unknown> | undefined;
  if (message === undefined) throw new ModelCallError("malformed", "provider returned no message");
  const content = typeof message.content === "string" && message.content.trim() !== "" ? message.content : null;
  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCalls = rawCalls.map((raw, index) => {
    const call = asRecord(raw, "tool call");
    const fn = asRecord(call.function, "tool call function");
    if (typeof fn.name !== "string" || fn.name === "") throw new ModelCallError("malformed", "tool call has no name");
    return {
      id: typeof call.id === "string" && call.id !== "" ? call.id : `call_${index}`,
      name: fn.name,
      arguments: typeof fn.arguments === "string" ? fn.arguments : "{}",
    };
  });
  const finishReason = typeof first?.finish_reason === "string" ? first.finish_reason : null;
  // A reply cut off at the token limit can carry no text and no complete tool call. That is a
  // truncated turn, not a broken provider: hand it back as an empty turn so the loop can replan,
  // instead of failing the task.
  if (content === null && toolCalls.length === 0) {
    if (finishReason === "length") {
      return { content: "", toolCalls: [], finishReason, servedBy: typeof record.model === "string" && record.model !== "" ? record.model : requestedModel, promptTokens: null, completionTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, latencyMs };
    }
    throw new ModelCallError("malformed", "provider returned neither text nor tool calls");
  }
  const usage = (record.usage ?? {}) as Record<string, unknown>;
  const details = (usage.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const servedBy = typeof record.model === "string" && record.model !== "" ? record.model : requestedModel;
  return {
    content,
    toolCalls,
    finishReason,
    servedBy,
    promptTokens: numberOrNull(usage.prompt_tokens),
    completionTokens: numberOrNull(usage.completion_tokens),
    cacheReadTokens: numberOrNull(details.cached_tokens),
    cacheWriteTokens: numberOrNull(details.cache_write_tokens),
    costUsd: numberOrNull(usage.cost),
    latencyMs,
  };
}

// Decisions API reply: { model, answers: { <questionId>: {...} }, usage: { input_tokens, output_tokens, cost } }.
function parseDecisionsBody(body: unknown, requestedModel: string, latencyMs: number): DecisionsReply {
  const record = asRecord(body, "decisions body");
  const answers = asRecord(record.answers, "decisions answers");
  const usage = (record.usage ?? {}) as Record<string, unknown>;
  const servedBy = typeof record.model === "string" && record.model !== "" ? record.model : requestedModel;
  return {
    answers,
    servedBy,
    promptTokens: numberOrNull(usage.input_tokens),
    completionTokens: numberOrNull(usage.output_tokens),
    costUsd: numberOrNull(usage.cost),
    latencyMs,
  };
}
