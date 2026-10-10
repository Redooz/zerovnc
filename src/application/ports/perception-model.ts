import type { ElementRelation, ObservedElement } from "../../domain/perception/observation.ts";
import type { Screenshot } from "../../domain/desktop/screenshot.ts";

export interface PerceptionRequest {
  readonly observationId: string;
  readonly screenshot: Screenshot;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

// Elements the model read from the screenshot, already checked against the
// observation contract by the adapter's mapper. Elements whose boxes cannot be
// grounded are dropped and counted in `rejectedElements`.
export interface PerceptionDraft {
  readonly elements: readonly ObservedElement[];
  readonly relations: readonly ElementRelation[];
  readonly rejectedElements: number;
  // Why elements were rejected (id and reason), capped; for traces and diagnosis.
  readonly rejections?: readonly string[];
}

export interface ModelCallMetadata {
  readonly model: string;
  readonly servedBy: string;
  readonly promptVersion: string;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  // Provider prompt-cache usage; absent or null when the route reports none.
  readonly cacheReadTokens?: number | null;
  readonly cacheWriteTokens?: number | null;
  readonly costUsd: number | null;
  readonly latencyMs: number;
}

export interface PerceptionOutput {
  readonly draft: PerceptionDraft;
  readonly metadata: ModelCallMetadata;
}
