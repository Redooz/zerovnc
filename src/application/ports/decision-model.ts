import type { DecisionAnswer, DecisionQuestion } from "../../domain/decisions/decision.ts";
import type { ModelCallMetadata } from "./perception-model.ts";

// One piece of observed evidence a question may cite. `id` is an element id from the observation.
export interface EvidenceItem {
  readonly id: string;
  readonly text: string;
}

export interface DecisionRequest {
  readonly question: DecisionQuestion;
  readonly evidence: readonly EvidenceItem[];
  // Optional PNG image the model reads alongside the evidence (for example a
  // screenshot with numbered candidate boxes). Adapters that cannot read images reject it.
  readonly image?: Uint8Array;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

export interface DecisionOutput {
  readonly answer: DecisionAnswer;
  readonly metadata: ModelCallMetadata;
}
