// Records every decision call exactly as sent and answered, so a surprising result can
// be inspected instead of guessed at. Images are noted by size, never inlined.
import { renderState, toWire } from "../../src/adapters/outbound/openrouter/decision-adapter.ts";
import type { DecisionQuestionWire } from "../../src/adapters/outbound/openrouter/openrouter-client.ts";
import type { PromptFile } from "../../src/adapters/outbound/openrouter/prompt-file.ts";
import type { ModelRoute } from "../../src/application/models/route.ts";
import type { DecisionOutput, DecisionRequest } from "../../src/application/ports/decision-model.ts";
import { ModelCallError } from "../../src/application/ports/model-call-error.ts";
import type { DecisionAnswer } from "../../src/domain/decisions/decision.ts";

export interface DecisionTrace {
  readonly model: string;
  readonly questionId: string;
  // Exactly the question and state text sent to the Decisions API.
  readonly wire: DecisionQuestionWire;
  readonly state: string;
  readonly imageBytes: number | null;
  readonly latencyMs: number;
  readonly result:
    | { readonly status: "ok"; readonly answer: DecisionAnswer; readonly servedBy: string }
    | { readonly status: "error"; readonly kind: string; readonly retryable: boolean; readonly message: string };
}

export function recordDecisions(
  route: ModelRoute<DecisionRequest, DecisionOutput>,
  sink: DecisionTrace[],
  prompt: PromptFile,
): ModelRoute<DecisionRequest, DecisionOutput> {
  return {
    model: route.model,
    async call(request: DecisionRequest): Promise<DecisionOutput> {
      const base = {
        model: route.model,
        questionId: request.question.id,
        wire: toWire(request.question, prompt.text),
        state: renderState(request.question, request.evidence),
        imageBytes: request.image?.byteLength ?? null,
      };
      const started = performance.now();
      try {
        const output = await route.call(request);
        sink.push({ ...base, latencyMs: Math.round(performance.now() - started), result: { status: "ok", answer: output.answer, servedBy: output.metadata.servedBy } });
        return output;
      } catch (error) {
        const kind = error instanceof ModelCallError ? error.kind : "unexpected";
        const retryable = error instanceof ModelCallError ? error.retryable : false;
        sink.push({
          ...base,
          latencyMs: Math.round(performance.now() - started),
          result: { status: "error", kind, retryable, message: error instanceof Error ? error.message : "unknown" },
        });
        throw error;
      }
    },
  };
}
