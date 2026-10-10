import { describe, expect, test } from "bun:test";
import {
  answerIssues,
  DecisionError,
  questionIssues,
  validateAnswer,
  type BooleanQuestion,
  type ChoiceQuestion,
  type ScoreQuestion,
} from "../../src/domain/decisions/decision.ts";

const choice: ChoiceQuestion = {
  kind: "choice",
  id: "select-control",
  text: "Which control saves?",
  criteria: "label matches save",
  options: [
    { id: "b1", label: "Guardar" },
    { id: "b2", label: "Cancelar" },
    { id: "none", label: "none" },
    { id: "insufficient_evidence", label: "unclear" },
  ],
};
const boolQ: BooleanQuestion = { kind: "boolean", id: "unique", text: "Unique?", criteria: "one row" };
const score: ScoreQuestion = {
  kind: "score",
  id: "transition",
  text: "Supported?",
  criteria: "named elements visible",
  levels: [
    { id: "supported", label: "supported" },
    { id: "partial", label: "partial" },
    { id: "insufficient_evidence", label: "unclear" },
  ],
};

describe("question definitions", () => {
  test("choice questions need none and insufficient_evidence options", () => {
    const missing = { ...choice, options: [{ id: "b1", label: "x" }, { id: "b2", label: "y" }] };
    expect(questionIssues(missing).join(" ")).toMatch(/insufficient_evidence/);
    expect(questionIssues(missing).join(" ")).toMatch(/must include none/);
  });

  test("score questions need an abstention level", () => {
    const missing = { ...score, levels: [{ id: "supported", label: "s" }, { id: "partial", label: "p" }] };
    expect(questionIssues(missing).join(" ")).toMatch(/insufficient_evidence/);
  });

  test("duplicate options are rejected", () => {
    const dup = { ...choice, options: [...choice.options, { id: "b1", label: "again" }] };
    expect(questionIssues(dup).join(" ")).toMatch(/distinct/);
  });
});

describe("answers", () => {
  test("a valid choice answer passes", () => {
    const answer = {
      kind: "choice" as const,
      questionId: "select-control",
      selected: "b1",
      probabilities: { b1: 0.8, b2: 0.1, none: 0.05, insufficient_evidence: 0.05 },
      confidence: 0.8,
      evidenceIds: ["b1"],
    };
    expect(validateAnswer(choice, answer)).toBe(answer);
  });

  test("an answer for another question is rejected", () => {
    const answer = { kind: "choice" as const, questionId: "other", selected: "b1", probabilities: {}, confidence: 0.5, evidenceIds: [] };
    expect(answerIssues(choice, answer).join(" ")).toMatch(/different question/);
  });

  test("an answer whose kind does not match the question is rejected", () => {
    const answer = { kind: "boolean" as const, questionId: "select-control", answer: "yes" as const, probabilityYes: 0.9, confidence: 0.9, evidenceIds: [] };
    expect(answerIssues(choice, answer).join(" ")).toMatch(/does not match/);
  });

  test("probabilities must be in range and sum to one", () => {
    const outOfRange = { kind: "choice" as const, questionId: "select-control", selected: "b1", probabilities: { b1: 1.4, b2: -0.4, none: 0, insufficient_evidence: 0 }, confidence: 0.5, evidenceIds: [] };
    expect(answerIssues(choice, outOfRange).join(" ")).toMatch(/out of range/);
    const notSumming = { ...outOfRange, probabilities: { b1: 0.3, b2: 0.3, none: 0.1, insufficient_evidence: 0.1 } };
    expect(answerIssues(choice, notSumming).join(" ")).toMatch(/sum to 1/);
  });

  test("selected option must be the most probable one and belong to the question", () => {
    const wrong = { kind: "choice" as const, questionId: "select-control", selected: "b1", probabilities: { b1: 0.2, b2: 0.7, none: 0.05, insufficient_evidence: 0.05 }, confidence: 0.5, evidenceIds: [] };
    expect(answerIssues(choice, wrong).join(" ")).toMatch(/most probable/);
    const foreign = { ...wrong, selected: "zz" };
    expect(answerIssues(choice, foreign).join(" ")).toMatch(/not part of the question/);
  });

  test("boolean yes must agree with its probability", () => {
    const contradiction = { kind: "boolean" as const, questionId: "unique", answer: "yes" as const, probabilityYes: 0.2, confidence: 0.6, evidenceIds: [] };
    expect(answerIssues(boolQ, contradiction).join(" ")).toMatch(/contradicts/);
    const consistent = { ...contradiction, answer: "no" as const };
    expect(answerIssues(boolQ, consistent)).toEqual([]);
  });

  test("score level must belong to the question and be most probable", () => {
    const ok = { kind: "score" as const, questionId: "transition", level: "supported", probabilities: { supported: 0.7, partial: 0.2, insufficient_evidence: 0.1 }, confidence: 0.7, evidenceIds: [] };
    expect(answerIssues(score, ok)).toEqual([]);
    expect(() => validateAnswer(score, { ...ok, level: "maybe" })).toThrow(DecisionError);
  });
});
