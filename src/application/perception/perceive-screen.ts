import { createObservation, ObservationError, type Observation } from "../../domain/perception/observation.ts";
import type { Screenshot } from "../../domain/desktop/screenshot.ts";
import type { TaskId } from "../../domain/tasks/task.ts";
import type { ModelRoute } from "../models/route.ts";
import { callWithFallback } from "../models/route.ts";
import type { PerceptionOutput, PerceptionRequest } from "../ports/perception-model.ts";
import { ModelCallError } from "../ports/model-call-error.ts";
import type { ModelCallObserver } from "../ports/model-call-observer.ts";
import { PerceptionFrameCache } from "./frame-cache.ts";

export type AbstentionReason = "model_failed" | "unreadable_output" | "no_grounded_elements";

export type PerceptionOutcome =
  | {
      readonly status: "observed";
      readonly observation: Observation;
      readonly metadata: PerceptionOutput["metadata"];
      readonly fallbackReason: string | null;
      readonly rejectedElements: number;
      readonly rejections: readonly string[];
      // "hit": no model was called, the validated draft of an identical earlier frame was reused.
      readonly cache: "hit" | "miss" | "off";
    }
  | {
      readonly status: "abstained";
      readonly reason: AbstentionReason;
      readonly detail: string;
      readonly fallbackReason: string | null;
    };

export interface PerceiveScreenDeps {
  readonly primary: ModelRoute<PerceptionRequest, PerceptionOutput>;
  readonly fallback: ModelRoute<PerceptionRequest, PerceptionOutput>;
  readonly timeoutMs: number;
  readonly observe?: ModelCallObserver;
  // Task-scoped exact-frame cache. `version` is the perception prompt/schema version.
  readonly cache?: { readonly store: PerceptionFrameCache; readonly version: string };
}

export interface PerceiveInput {
  readonly taskId: TaskId;
  readonly screenshot: Screenshot;
  readonly signal: AbortSignal;
}

// Turns one screenshot into a validated observation, or an explicit abstention.
// Missing or ungroundable evidence is never filled in with guesses.
export class PerceiveScreen {
  constructor(private readonly deps: PerceiveScreenDeps) {}

  async perceive(input: PerceiveInput): Promise<PerceptionOutcome> {
    const request: PerceptionRequest = {
      observationId: input.screenshot.observationId,
      screenshot: input.screenshot,
      signal: input.signal,
      timeoutMs: this.deps.timeoutMs,
    };

    const cache = this.deps.cache;
    const key = cache === undefined ? null : PerceptionFrameCache.keyFor(input.screenshot, [this.deps.primary.model, this.deps.fallback.model], cache.version);
    const cached = cache !== undefined && key !== null ? cache.store.get(key) : null;

    let result: PerceptionOutput;
    let fallbackReason: string | null;
    let cacheState: "hit" | "miss" | "off" = cache === undefined ? "off" : "miss";
    if (cached !== null) {
      // Exact frame seen before: reuse the validated draft, with no model call, tokens, or cost.
      cacheState = "hit";
      result = {
        draft: cached.output.draft,
        metadata: { ...cached.output.metadata, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, latencyMs: 0 },
      };
      fallbackReason = cached.fallbackReason;
    } else {
      let routed;
      try {
        routed = await callWithFallback(this.deps.primary, this.deps.fallback, request, input.signal);
      } catch (error) {
        const detail = error instanceof ModelCallError ? error.kind : "unexpected error";
        this.deps.observe?.({
          role: "perception",
          observationId: request.observationId,
          questionId: null,
          configuredModel: this.deps.primary.model,
          servedBy: null,
          promptVersion: null,
          fallbackReason: null,
          promptTokens: null,
          completionTokens: null,
          localCache: cacheState === "miss" ? "miss" : null,
          costUsd: null,
          latencyMs: null,
          outcome: "failed",
          failure: detail,
        });
        return { status: "abstained", reason: "model_failed", detail, fallbackReason: null };
      }
      result = routed.result;
      fallbackReason = routed.fallbackReason;
    }

    this.deps.observe?.({
      role: "perception",
      observationId: request.observationId,
      questionId: null,
      configuredModel: this.deps.primary.model,
      servedBy: result.metadata.servedBy,
      promptVersion: result.metadata.promptVersion,
      fallbackReason,
      promptTokens: result.metadata.promptTokens,
      completionTokens: result.metadata.completionTokens,
      cacheReadTokens: result.metadata.cacheReadTokens ?? null,
      cacheWriteTokens: result.metadata.cacheWriteTokens ?? null,
      localCache: cacheState === "off" ? null : cacheState,
      costUsd: result.metadata.costUsd,
      latencyMs: result.metadata.latencyMs,
      outcome: "ok",
      failure: null,
    });
    try {
      const observation = createObservation({
        id: input.screenshot.observationId,
        taskId: input.taskId,
        capturedAt: input.screenshot.capturedAt,
        width: input.screenshot.width,
        height: input.screenshot.height,
        frameRevision: input.screenshot.frameRevision,
        screenshotRef: null,
        elements: result.draft.elements,
        relations: result.draft.relations,
      });
      if (observation.elements.length === 0) {
        return {
          status: "abstained",
          reason: "no_grounded_elements",
          detail: `${result.draft.rejectedElements} element(s) rejected`,
          fallbackReason,
        };
      }
      // Only drafts that passed observation validation are cached, never failures or abstentions.
      if (cache !== undefined && key !== null && cacheState === "miss") cache.store.set(key, result, fallbackReason);
      return {
        status: "observed",
        observation,
        metadata: result.metadata,
        fallbackReason,
        rejectedElements: result.draft.rejectedElements,
        rejections: result.draft.rejections ?? [],
        cache: cacheState,
      };
    } catch (error) {
      if (error instanceof ObservationError) {
        return { status: "abstained", reason: "unreadable_output", detail: error.issues.join("; "), fallbackReason };
      }
      throw error;
    }
  }
}
