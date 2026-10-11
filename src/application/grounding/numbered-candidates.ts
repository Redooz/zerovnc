// Direct-image grounding: candidates are numbered on the screenshot, the decision
// model picks a number, and code maps the number back to an observed element.
// The mapping lives here so the model never outputs coordinates.
import { INSUFFICIENT_EVIDENCE, NONE_OPTION, type ChoiceQuestion } from "../../domain/decisions/decision.ts";
import { type ControlKind, type NumberedBox, type Observation, type ObservedElement } from "../../domain/perception/observation.ts";
import type { EvidenceItem } from "../ports/decision-model.ts";
import { abstentionOptionLabel, candidateOptionLabel, describeInContext, duplicateOf, type QuestionTemplate } from "./grounding-service.ts";

export const MAX_NUMBERED_CANDIDATES = 40;

export interface NumberedEntry {
  readonly number: number;
  // Option id used in the decision question ("n1", "n2", ...).
  readonly optionId: string;
  readonly element: ObservedElement;
}

export interface NumberedCandidates {
  readonly entries: readonly NumberedEntry[];
  readonly overlay: readonly NumberedBox[];
  readonly evidence: readonly EvidenceItem[];
  readonly question: ChoiceQuestion;
}

export type NumberedResult =
  | { readonly status: "ready"; readonly candidates: NumberedCandidates }
  | { readonly status: "abstained"; readonly reason: "no_candidates" | "too_many_candidates"; readonly detail: string };

// Numbers visible candidates of the given kinds, in observation order (top-left to bottom-right).
export function buildNumberedCandidates(
  observation: Observation,
  intent: string,
  kinds: readonly ControlKind[],
  what: "control" | "field",
  template: QuestionTemplate = "v1",
  abstention: "option" | "threshold" = "option",
): NumberedResult {
  const visible = observation.elements
    .filter((element) => element.visible && kinds.includes(element.kind))
    .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  if (visible.length === 0) return { status: "abstained", reason: "no_candidates", detail: `no visible ${what} candidates` };
  if (visible.length > MAX_NUMBERED_CANDIDATES) {
    return { status: "abstained", reason: "too_many_candidates", detail: `${visible.length} candidates exceed the limit` };
  }

  const entries: NumberedEntry[] = visible.map((element, index) => ({
    number: index + 1,
    optionId: `n${index + 1}`,
    element,
  }));
  const numberedOptions = entries.map((entry) => ({ id: entry.optionId, label: `box ${entry.number}: ${candidateOptionLabel(observation, entry.element, template)}` }));
  const question: ChoiceQuestion =
    abstention === "threshold"
      ? {
          kind: "choice",
          id: "select-numbered",
          text: `Which numbered ${what} on the screenshot best matches this intent: ${intent}?`,
          criteria: `Pick the number of the single ${what} whose label matches the intent.`,
          options: numberedOptions,
          abstention: "threshold",
        }
      : {
          kind: "choice",
          id: "select-numbered",
          text: `Which numbered ${what} on the screenshot best matches this intent: ${intent}?`,
          criteria: `Pick the number of the single ${what} whose label matches the intent. Pick ${NONE_OPTION} if none match. Pick ${INSUFFICIENT_EVIDENCE} if the labels are unreadable or the choice is unclear.`,
          options: [
            ...numberedOptions,
            { id: NONE_OPTION, label: "none of the numbered boxes" },
            { id: INSUFFICIENT_EVIDENCE, label: abstentionOptionLabel(template) },
          ],
        };
  return {
    status: "ready",
    candidates: {
      entries,
      overlay: entries.map((entry) => ({ number: entry.number, box: entry.element.box })),
      evidence: entries.map((entry) => ({ id: entry.optionId, text: `box ${entry.number}: ${describeInContext(observation, entry.element)}` })),
      question,
    },
  };
}

export type ResolvedNumber =
  | { readonly status: "grounded"; readonly element: ObservedElement; readonly number: number }
  | { readonly status: "abstained"; readonly reason: "no_match" | "insufficient_evidence" | "invalid_answer" };

// Maps the selected option back to the element it was drawn on.
// `probability` and `threshold` apply only in threshold mode: below the threshold, abstain.
export function resolveNumberedChoice(
  candidates: NumberedCandidates,
  selected: string,
  probability: number | null = null,
  threshold: number | null = null,
  margin: number | null = null,
  minMargin: number | null = null,
): ResolvedNumber {
  if (threshold !== null && (probability === null || probability < threshold)) {
    return { status: "abstained", reason: "insufficient_evidence" };
  }
  if (minMargin !== null && margin !== null && margin < minMargin) {
    return { status: "abstained", reason: "insufficient_evidence" };
  }
  if (selected === NONE_OPTION) return { status: "abstained", reason: "no_match" };
  if (selected === INSUFFICIENT_EVIDENCE) return { status: "abstained", reason: "insufficient_evidence" };
  const entry = candidates.entries.find((candidate) => candidate.optionId === selected);
  if (entry === undefined) return { status: "abstained", reason: "invalid_answer" };
  // Same guard as the text path: an indistinguishable twin means the target is ambiguous.
  if (duplicateOf(entry.element, candidates.entries.map((e) => e.element)) !== null) {
    return { status: "abstained", reason: "invalid_answer" };
  }
  return { status: "grounded", element: entry.element, number: entry.number };
}
