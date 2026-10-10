// Builds the perception and decision routes from configuration. Model IDs come
// from config (env vars with defaults) and the resolved IDs are logged once.
import type { AppConfig } from "./config.ts";
import type { Logger } from "../application/ports/logger.ts";
import type { ModelRoute } from "../application/models/route.ts";
import type { PerceptionOutput, PerceptionRequest } from "../application/ports/perception-model.ts";
import type { DecisionOutput, DecisionRequest } from "../application/ports/decision-model.ts";
import { OpenRouterClient, type FetchLike } from "../adapters/outbound/openrouter/openrouter-client.ts";
import { OpenRouterPerceptionModel, PERCEPTION_PROMPT_FILE } from "../adapters/outbound/openrouter/perception-adapter.ts";
import { OpenRouterDecisionModel } from "../adapters/outbound/openrouter/decision-adapter.ts";
import { loadPromptFile } from "../adapters/outbound/openrouter/prompt-file.ts";
import { DEFAULT_RETRY, withRetry, type RetryPolicy } from "../application/models/retry.ts";

export interface ModelRoutes {
  // Shared OpenRouter client; the planner's tool-calling requests use it too.
  readonly client: OpenRouterClient;
  readonly perceptionPromptVersion: string;
  readonly perception: { readonly primary: ModelRoute<PerceptionRequest, PerceptionOutput>; readonly fallback: ModelRoute<PerceptionRequest, PerceptionOutput> };
  readonly decision: { readonly primary: ModelRoute<DecisionRequest, DecisionOutput>; readonly fallback: ModelRoute<DecisionRequest, DecisionOutput> };
}

// Explicit cache breakpoints are sent only to routes where a live run showed cache reads:
// Anthropic models. DeepSeek, JEV, and Luna Decisions showed no cache usage (Phase 3 step
// 3.7), so nothing is sent to them. Re-verify before extending this list.
export function supportsExplicitCacheBreakpoint(modelId: string): boolean {
  return modelId.startsWith("anthropic/");
}

export interface ModelRouteOptions {
  readonly fetchImpl?: FetchLike;
  // Defaults to one retry on retryable provider failures. Every retry is logged.
  readonly retry?: Partial<RetryPolicy>;
  // Benchmarks only: run another perception prompt file (for example the previous version, as a baseline).
  readonly perceptionPromptFile?: string;
}

export function createModelRoutes(config: AppConfig, logger: Logger, options: ModelRouteOptions = {}): ModelRoutes {
  const client = new OpenRouterClient(config.openRouterApiKey, undefined, options.fetchImpl, undefined, config.providerSort ?? null);
  const retry: RetryPolicy = {
    ...DEFAULT_RETRY,
    onRetry: (info) => logger.info("model call retried", { model: info.model, attempt: info.attempt }),
    ...options.retry,
  };
  const perceptionPrompt = loadPromptFile(options.perceptionPromptFile ?? PERCEPTION_PROMPT_FILE);
  const decisionPrompt = loadPromptFile("decision.v1.md");
  logger.info("models resolved", {
    perception: config.models.perception,
    perception_fallback: config.models.perceptionFallback,
    decision: config.models.decision,
    decision_fallback: config.models.decisionFallback,
    planner: config.models.planner,
    planner_fallback: config.models.plannerFallback,
    perception_prompt: perceptionPrompt.version,
    decision_prompt: decisionPrompt.version,
  });
  return {
    client,
    perceptionPromptVersion: perceptionPrompt.version,
    perception: {
      primary: withRetry(new OpenRouterPerceptionModel(client, config.models.perception, perceptionPrompt, supportsExplicitCacheBreakpoint(config.models.perception)), retry),
      fallback: withRetry(new OpenRouterPerceptionModel(client, config.models.perceptionFallback, perceptionPrompt, supportsExplicitCacheBreakpoint(config.models.perceptionFallback)), retry),
    },
    decision: {
      primary: withRetry(new OpenRouterDecisionModel(client, config.models.decision, decisionPrompt), retry),
      fallback: withRetry(new OpenRouterDecisionModel(client, config.models.decisionFallback, decisionPrompt), retry),
    },
  };
}
