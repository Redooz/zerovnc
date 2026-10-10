// Maps Decisions API answers to typed domain answers. Lives beside the adapter.
// Wire shapes (verified against the live API):
//   choice: { type: "choice", choice: <option key>, probabilities: { <key>: p }, confidence }
//   score:  { type: "score", score, legend: { "<index>": <label> }, probabilities: { "<index>": p }, confidence }
// A boolean question is sent as a choice over yes / no / insufficient_evidence.
// The API returns no evidence citations: a choice cites the selected candidate
// (which the grounding service then checks against the observation); other kinds cite nothing.
import { ModelCallError } from "../../../application/ports/model-call-error.ts";
import type { EvidenceItem } from "../../../application/ports/decision-model.ts";
import {
  DecisionError,
  INSUFFICIENT_EVIDENCE,
  validateAnswer,
  type DecisionAnswer,
  type DecisionQuestion,
} from "../../../domain/decisions/decision.ts";

export const BOOLEAN_OPTIONS = ["yes", "no", INSUFFICIENT_EVIDENCE] as const;

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ModelCallError("malformed", `${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function probabilityMap(value: unknown, keys: readonly string[], what: string): Record<string, number> {
  const raw = record(value, what);
  const out: Record<string, number> = {};
  for (const key of keys) {
    const p = raw[key];
    if (typeof p !== "number" || !Number.isFinite(p)) {
      throw new ModelCallError("malformed", `${what} has no number for ${key}`);
    }
    out[key] = p;
  }
  return out;
}

function confidenceOf(raw: Record<string, unknown>): number {
  if (typeof raw.confidence !== "number" || !Number.isFinite(raw.confidence)) {
    throw new ModelCallError("malformed", "decision answer has no confidence");
  }
  return raw.confidence;
}

function argmaxKey(probabilities: Record<string, number>): string {
  let best = "";
  let bestValue = -Infinity;
  for (const [key, value] of Object.entries(probabilities)) {
    if (value > bestValue) {
      best = key;
      bestValue = value;
    }
  }
  return best;
}

// Maps one answer object for one question into a validated domain answer.
export function mapDecisionAnswer(answers: Readonly<Record<string, unknown>>, question: DecisionQuestion, evidence: readonly EvidenceItem[]): DecisionAnswer {
  const raw = record(answers[question.id], `answer for ${question.id}`);
  const evidenceIds = new Set(evidence.map((item) => item.id));
  let answer: DecisionAnswer;

  if (question.kind === "boolean") {
    const probabilities = probabilityMap(raw.probabilities, BOOLEAN_OPTIONS, "boolean probabilities");
    const selected = String(raw.choice);
    if (!(BOOLEAN_OPTIONS as readonly string[]).includes(selected)) {
      throw new ModelCallError("malformed", "boolean answer is not yes, no, or insufficient_evidence");
    }
    answer = {
      kind: "boolean",
      questionId: question.id,
      answer: selected as "yes" | "no" | typeof INSUFFICIENT_EVIDENCE,
      probabilityYes: probabilities.yes ?? 0,
      confidence: confidenceOf(raw),
      evidenceIds: [],
    };
  } else if (question.kind === "choice") {
    const keys = question.options.map((option) => option.id);
    const probabilities = probabilityMap(raw.probabilities, keys, "choice probabilities");
    const selected = typeof raw.choice === "string" ? raw.choice : "";
    answer = {
      kind: "choice",
      questionId: question.id,
      selected,
      probabilities,
      confidence: confidenceOf(raw),
      evidenceIds: evidenceIds.has(selected) ? [selected] : [],
    };
  } else {
    // Score levels are sent in order; the API keys probabilities by index.
    const indices = question.levels.map((_, index) => String(index));
    const byIndex = probabilityMap(raw.probabilities, indices, "score probabilities");
    const probabilities: Record<string, number> = {};
    question.levels.forEach((level, index) => {
      probabilities[level.id] = byIndex[String(index)] ?? 0;
    });
    const top = argmaxKey(probabilities);
    answer = {
      kind: "score",
      questionId: question.id,
      level: top,
      probabilities,
      confidence: confidenceOf(raw),
      evidenceIds: [],
    };
  }

  try {
    return validateAnswer(question, answer);
  } catch (error) {
    if (error instanceof DecisionError) {
      throw new ModelCallError("malformed", `answer failed validation: ${error.issues.join("; ")}`);
    }
    throw error;
  }
}
