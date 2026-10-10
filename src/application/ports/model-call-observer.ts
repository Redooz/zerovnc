// One model call, as it is recorded in a trace. Carries identifiers, versions,
// usage, and outcome only: never prompts, images, or responses. Screenshots are
// referenced by observation id.
export interface ModelCallEvent {
  readonly role: "perception" | "decision";
  readonly observationId: string;
  readonly questionId: string | null;
  readonly configuredModel: string;
  readonly servedBy: string | null;
  readonly promptVersion: string | null;
  readonly fallbackReason: string | null;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly cacheReadTokens?: number | null;
  readonly cacheWriteTokens?: number | null;
  // Local exact-frame cache: "hit" means no model was called for this frame.
  readonly localCache?: "hit" | "miss" | null;
  readonly costUsd: number | null;
  readonly latencyMs: number | null;
  readonly outcome: "ok" | "failed";
  readonly failure: string | null;
}

export type ModelCallObserver = (event: ModelCallEvent) => void;
