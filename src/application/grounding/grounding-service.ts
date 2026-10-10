// Grounding: asks bounded questions over candidates taken from one observation.
// The model only chooses among observed candidates; code resolves coordinates,
// counts matches, and checks date arithmetic. Every question offers an abstention.
import {
  DecisionError,
  INSUFFICIENT_EVIDENCE,
  NONE_OPTION,
  validateAnswer,
  type ChoiceQuestion,
  type DecisionAnswer,
  type ScoreQuestion,
} from "../../domain/decisions/decision.ts";
import { findElement, type ControlKind, type Observation, type ObservedElement } from "../../domain/perception/observation.ts";
import { callWithFallback, type ModelRoute } from "../models/route.ts";
import type { DecisionOutput, DecisionRequest, EvidenceItem } from "../ports/decision-model.ts";
import { ModelCallError } from "../ports/model-call-error.ts";
import type { ModelCallObserver } from "../ports/model-call-observer.ts";

// A bounded choice keeps the question answerable; larger candidate sets abstain.
export const MAX_CHOICE_CANDIDATES = 40;
export const MAX_EVIDENCE_ITEMS = 80;

export const CONTROL_CANDIDATE_KINDS: readonly ControlKind[] = [
  "button",
  "link",
  "tab",
  "menu_item",
  "icon_button",
  "checkbox",
  "dropdown",
];
export const FIELD_CANDIDATE_KINDS: readonly ControlKind[] = ["text_field", "date_field", "dropdown", "checkbox"];

export type GroundingAbstention =
  | "no_candidates"
  | "too_many_candidates"
  | "insufficient_evidence"
  | "no_match"
  | "ambiguous"
  | "model_failed"
  | "invalid_answer"
  | "below_threshold"
  | "ambiguous_margin"
  | "ambiguous_duplicate";

export type GroundingOutcome<T> =
  | {
      readonly status: "grounded";
      readonly value: T;
      readonly evidenceIds: readonly string[];
      readonly servedBy: string;
      readonly fallbackReason: string | null;
      // Probability the model gave the chosen option (threshold mode and option mode alike).
      readonly probability: number | null;
      // Lead of the chosen option over the runner-up; null when there is no other option.
      readonly margin: number | null;
    }
  | { readonly status: "abstained"; readonly reason: GroundingAbstention; readonly detail: string };

export interface ScoreOutcome {
  readonly status: "scored";
  readonly level: string;
  readonly confidence: number;
  readonly servedBy: string;
}

// Question templates. "v1" is the Phase 3 default. "v2" changes only option wording:
// the candidate's label instead of its full description, and a plainer abstention
// label. Both keep the required insufficient_evidence option id.
export type QuestionTemplate = "v1" | "v2";

// The caption of a field, from a "labels" relation in the observation (perception contract).
export function labelTextFor(observation: Observation, element: ObservedElement): string | null {
  const relation = observation.relations.find((r) => r.kind === "labels" && r.to === element.id);
  if (relation === undefined) return null;
  const label = findElement(observation, relation.from)?.label.trim() ?? "";
  return label === "" ? null : label;
}

// Describes a candidate with its caption when one is known, so a field can be matched by name.
export function describeInContext(observation: Observation, element: ObservedElement): string {
  const caption = labelTextFor(observation, element);
  return caption === null ? describe(element) : `${describe(element)} captioned "${caption}"`;
}

export function candidateOptionLabel(observation: Observation, element: ObservedElement, template: QuestionTemplate): string {
  if (template === "v1") return describeInContext(observation, element);
  const caption = labelTextFor(observation, element);
  if (element.label.trim() !== "") return element.label;
  return caption ?? describeInContext(observation, element);
}

export function abstentionOptionLabel(template: QuestionTemplate): string {
  return template === "v1" ? "insufficient evidence" : "none of the candidates clearly matches the intent";
}

export interface GroundingDeps {
  readonly primary: ModelRoute<DecisionRequest, DecisionOutput>;
  readonly fallback: ModelRoute<DecisionRequest, DecisionOutput>;
  readonly timeoutMs: number;
  readonly observe?: ModelCallObserver;
  readonly template?: QuestionTemplate;
  // "option": the model may answer none / insufficient_evidence (default).
  // "threshold": the model chooses among candidates only; code abstains when the
  // top probability is below `threshold`.
  // minMargin: required lead of the top probability over the runner-up. It catches
  // near-ties between duplicates that a probability threshold alone cannot.
  readonly abstention?:
    | { readonly mode: "option" }
    | { readonly mode: "threshold"; readonly threshold: number; readonly minMargin?: number };
}

export interface GroundingRequestBase {
  readonly observation: Observation;
  readonly signal: AbortSignal;
}

export class GroundingService {
  constructor(private readonly deps: GroundingDeps) {}

  // Which visible control best matches the intent (for example "Guardar").
  selectControl(input: GroundingRequestBase & { readonly intent: string }): Promise<GroundingOutcome<ObservedElement>> {
    return this.choose({ ...input, kinds: CONTROL_CANDIDATE_KINDS, questionId: "select-control", what: "control" });
  }

  // Which visible field should receive a value (for example the field labelled "Precio").
  selectField(input: GroundingRequestBase & { readonly intent: string }): Promise<GroundingOutcome<ObservedElement>> {
    return this.choose({ ...input, kinds: FIELD_CANDIDATE_KINDS, questionId: "select-field", what: "field" });
  }

  // Counts rows whose visible text contains the identity as whole words. Done in code: no model call.
  matchUniqueRecord(input: { readonly observation: Observation; readonly identity: string }): GroundingOutcome<ObservedElement> {
    const needle = normalize(input.identity);
    if (needle === "") {
      return { status: "abstained", reason: "no_match", detail: "identity is empty" };
    }
    const pattern = new RegExp(`(^|\\s)${escapeRegExp(needle)}(\\s|$)`);
    const rows = input.observation.elements.filter(
      (element) => element.visible && element.kind === "table_row" && pattern.test(normalize(element.label)),
    );
    if (rows.length === 0) return { status: "abstained", reason: "no_match", detail: "no visible row matches" };
    if (rows.length > 1) {
      return { status: "abstained", reason: "ambiguous", detail: `${rows.length} visible rows match` };
    }
    const [row] = rows;
    if (row === undefined) return { status: "abstained", reason: "no_match", detail: "no visible row matches" };
    return { status: "grounded", value: row, evidenceIds: [row.id], servedBy: "code", fallbackReason: null, probability: null, margin: null };
  }

  // Scores whether the observed screen supports an expected transition. Returns a level, never a yes/no guess.
  async scoreTransition(input: GroundingRequestBase & { readonly expectation: string }): Promise<ScoreOutcome | { status: "abstained"; reason: GroundingAbstention; detail: string }> {
    const question: ScoreQuestion = {
      kind: "score",
      id: "transition-support",
      text: `Does the screen support this expected state: ${input.expectation}?`,
      criteria:
        "supported: all named elements or values are visible. partial: some are visible. not_supported: none are visible, or a different screen is shown. insufficient_evidence: the screen cannot be read.",
      levels: [
        { id: "supported", label: "supported" },
        { id: "partial", label: "partial" },
        { id: "not_supported", label: "not supported" },
        { id: INSUFFICIENT_EVIDENCE, label: "insufficient evidence" },
      ],
    };
    const evidence = toEvidence(input.observation);
    const routed = await this.ask(question, evidence, input.signal, input.observation.id);
    if (routed.kind !== "ok") return { status: "abstained", reason: routed.reason, detail: routed.detail };
    const answer = routed.answer;
    if (answer.kind !== "score") return { status: "abstained", reason: "invalid_answer", detail: "unexpected answer kind" };
    if (answer.level === INSUFFICIENT_EVIDENCE) {
      return { status: "abstained", reason: "insufficient_evidence", detail: "model reported insufficient evidence" };
    }
    return { status: "scored", level: answer.level, confidence: answer.confidence, servedBy: routed.servedBy };
  }

  private async choose(input: GroundingRequestBase & {
    readonly intent: string;
    readonly kinds: readonly ControlKind[];
    readonly questionId: string;
    readonly what: "control" | "field";
  }): Promise<GroundingOutcome<ObservedElement>> {
    const template = this.deps.template ?? "v1";
    const candidates = input.observation.elements.filter((element) => element.visible && input.kinds.includes(element.kind));
    if (candidates.length === 0) {
      return { status: "abstained", reason: "no_candidates", detail: `no visible ${input.what} candidates` };
    }
    if (candidates.length > MAX_CHOICE_CANDIDATES) {
      return { status: "abstained", reason: "too_many_candidates", detail: `${candidates.length} candidates exceed the limit` };
    }

    const abstention = this.deps.abstention ?? { mode: "option" as const };
    const candidateOptions = candidates.map((element) => ({ id: element.id, label: candidateOptionLabel(input.observation, element, template) }));
    const question: ChoiceQuestion =
      abstention.mode === "threshold"
        ? {
            kind: "choice",
            id: input.questionId,
            text: `Which ${input.what} best matches this intent: ${input.intent}?`,
            criteria: `Pick the single ${input.what} whose visible label and value match the intent.`,
            options: candidateOptions,
            abstention: "threshold",
          }
        : {
            kind: "choice",
            id: input.questionId,
            text: `Which ${input.what} best matches this intent: ${input.intent}?`,
            criteria: `Pick the single ${input.what} whose visible label and value match the intent. Pick ${NONE_OPTION} if none match. Pick ${INSUFFICIENT_EVIDENCE} if the labels are unreadable or the choice is unclear.`,
            options: [
              ...candidateOptions,
              { id: NONE_OPTION, label: "none of the candidates" },
              { id: INSUFFICIENT_EVIDENCE, label: abstentionOptionLabel(template) },
            ],
          };
    const evidence = candidates.map((element) => ({ id: element.id, text: describeInContext(input.observation, element) }));
    const routed = await this.ask(question, evidence, input.signal, input.observation.id);
    if (routed.kind !== "ok") return { status: "abstained", reason: routed.reason, detail: routed.detail };
    const answer = routed.answer;
    if (answer.kind !== "choice") return { status: "abstained", reason: "invalid_answer", detail: "unexpected answer kind" };
    const probability = answer.probabilities[answer.selected] ?? null;
    const margin = marginOf(answer.probabilities, answer.selected);
    if (abstention.mode === "threshold") {
      if (probability === null || probability < abstention.threshold) {
        return { status: "abstained", reason: "below_threshold", detail: `top probability ${probability ?? "missing"} below ${abstention.threshold}` };
      }
      if (abstention.minMargin !== undefined && margin !== null && margin < abstention.minMargin) {
        return { status: "abstained", reason: "ambiguous_margin", detail: `margin ${margin.toFixed(2)} below ${abstention.minMargin}` };
      }
    }
    if (answer.selected === NONE_OPTION) return { status: "abstained", reason: "no_match", detail: `no candidate matches the ${input.what}` };
    if (answer.selected === INSUFFICIENT_EVIDENCE) {
      return { status: "abstained", reason: "insufficient_evidence", detail: `model could not choose a ${input.what}` };
    }
    const element = findElement(input.observation, answer.selected);
    if (element === undefined) {
      return { status: "abstained", reason: "invalid_answer", detail: "selected element is not in the observation" };
    }
    // Two visible candidates with the same kind and name cannot be told apart by label:
    // acting on either could change the wrong record. Refuse instead of guessing.
    const twin = duplicateOf(element, candidates);
    if (twin !== null) {
      return { status: "abstained", reason: "ambiguous_duplicate", detail: `${element.kind} "${element.label}" also appears as ${twin.id}` };
    }
    return {
      status: "grounded",
      value: element,
      evidenceIds: answer.evidenceIds,
      servedBy: routed.servedBy,
      fallbackReason: routed.fallbackReason,
      probability,
      margin,
    };
  }

  private async ask(
    question: DecisionRequest["question"],
    evidence: readonly EvidenceItem[],
    signal: AbortSignal,
    observationId: string,
  ): Promise<
    | { kind: "ok"; answer: DecisionAnswer; servedBy: string; fallbackReason: string | null }
    | { kind: "abstain"; reason: GroundingAbstention; detail: string }
  > {
    if (evidence.length > MAX_EVIDENCE_ITEMS) {
      return { kind: "abstain", reason: "too_many_candidates", detail: `${evidence.length} evidence items exceed the limit` };
    }
    const request: DecisionRequest = { question, evidence, signal, timeoutMs: this.deps.timeoutMs };
    const base = { role: "decision" as const, observationId, questionId: question.id, configuredModel: this.deps.primary.model };
    try {
      const outcome = await callWithFallback(this.deps.primary, this.deps.fallback, request, signal);
      const answer = validateAnswer(question, outcome.result.answer);
      const meta = outcome.result.metadata;
      this.deps.observe?.({
        ...base,
        servedBy: outcome.servedBy,
        promptVersion: meta.promptVersion,
        fallbackReason: outcome.fallbackReason,
        promptTokens: meta.promptTokens,
        completionTokens: meta.completionTokens,
        costUsd: meta.costUsd,
        latencyMs: meta.latencyMs,
        outcome: "ok",
        failure: null,
      });
      return { kind: "ok", answer, servedBy: outcome.servedBy, fallbackReason: outcome.fallbackReason };
    } catch (error) {
      if (error instanceof DecisionError) {
        this.observeFailure(base, "invalid_answer");
        return { kind: "abstain", reason: "invalid_answer", detail: error.issues.join("; ") };
      }
      if (error instanceof ModelCallError) {
        this.observeFailure(base, error.kind);
        return { kind: "abstain", reason: "model_failed", detail: error.kind };
      }
      throw error;
    }
  }

  private observeFailure(base: { role: "decision"; observationId: string; questionId: string; configuredModel: string }, failure: string): void {
    this.deps.observe?.({
      ...base,
      servedBy: null,
      promptVersion: null,
      fallbackReason: null,
      promptTokens: null,
      completionTokens: null,
      costUsd: null,
      latencyMs: null,
      outcome: "failed",
      failure,
    });
  }
}

// Text a decision model may read. Coordinates are deliberately absent.
export function describe(element: ObservedElement): string {
  const value = element.value.state === "text" ? `value "${element.value.text}"` : `value ${element.value.state}`;
  return `${element.kind} "${element.label}" (${value})`;
}

export function toEvidence(observation: Observation): EvidenceItem[] {
  return observation.elements
    .filter((element) => element.visible)
    .slice(0, MAX_EVIDENCE_ITEMS)
    .map((element) => ({ id: element.id, text: describe(element) }));
}

export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Lead of the selected option over the best other option; null with a single option.
export function marginOf(probabilities: Readonly<Record<string, number>>, selected: string): number | null {
  const own = probabilities[selected];
  if (own === undefined) return null;
  const others = Object.entries(probabilities).filter(([key]) => key !== selected).map(([, value]) => value);
  if (others.length === 0) return null;
  return own - Math.max(...others);
}

// A different visible candidate with the same kind and (non-empty) normalized label.
export function duplicateOf(element: ObservedElement, candidates: readonly ObservedElement[]): ObservedElement | null {
  const name = normalize(element.label);
  if (name === "") return null;
  return candidates.find((other) => other.id !== element.id && other.kind === element.kind && normalize(other.label) === name) ?? null;
}
