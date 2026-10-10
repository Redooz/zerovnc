// Typed decisions. A decision model answers one bounded question about observed
// evidence. Each question kind has its own answer shape, and every question
// offers an explicit "insufficient_evidence" option so abstention is always possible.
export const INSUFFICIENT_EVIDENCE = "insufficient_evidence" as const;
export const NONE_OPTION = "none" as const;

// Probabilities may not be exactly 1 after rounding; this tolerance absorbs it.
export const PROBABILITY_SUM_TOLERANCE = 0.01;

export interface QuestionOption {
  readonly id: string;
  readonly label: string;
}

// Yes/no judgment. The answer is "yes", "no", or abstention.
export interface BooleanQuestion {
  readonly kind: "boolean";
  readonly id: string;
  readonly text: string;
  readonly criteria: string;
}

// Selection among distinct options.
// abstention "option" (default): options must include "none" and "insufficient_evidence".
// abstention "threshold": the question offers only candidates; the caller abstains when
// the top probability is below its threshold. Used when the model abstains too readily
// when an explicit abstention option is offered (see Phase 3 progress log).
export interface ChoiceQuestion {
  readonly kind: "choice";
  readonly id: string;
  readonly text: string;
  readonly criteria: string;
  readonly options: readonly QuestionOption[];
  readonly abstention?: "option" | "threshold";
}

// Ordered levels with observable criteria. Must include "insufficient_evidence".
export interface ScoreQuestion {
  readonly kind: "score";
  readonly id: string;
  readonly text: string;
  readonly criteria: string;
  readonly levels: readonly QuestionOption[];
}

export type DecisionQuestion = BooleanQuestion | ChoiceQuestion | ScoreQuestion;

export type BooleanAnswer = {
  readonly kind: "boolean";
  readonly questionId: string;
  readonly answer: "yes" | "no" | typeof INSUFFICIENT_EVIDENCE;
  // Probability that the answer is "yes".
  readonly probabilityYes: number;
  readonly confidence: number;
  readonly evidenceIds: readonly string[];
};

export type ChoiceAnswer = {
  readonly kind: "choice";
  readonly questionId: string;
  readonly selected: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
  readonly evidenceIds: readonly string[];
};

export type ScoreAnswer = {
  readonly kind: "score";
  readonly questionId: string;
  readonly level: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
  readonly evidenceIds: readonly string[];
};

export type DecisionAnswer = BooleanAnswer | ChoiceAnswer | ScoreAnswer;

export class DecisionError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid decision: ${issues.join("; ")}`);
    this.name = "DecisionError";
  }
}

const ID = /^[A-Za-z0-9_-]{1,60}$/;

// Checks question definitions. Rejects duplicate options and missing abstention options.
export function questionIssues(question: DecisionQuestion): string[] {
  const issues: string[] = [];
  if (!ID.test(question.id)) issues.push("question id must be 1-60 letters, digits, '_' or '-'");
  if (question.text.trim() === "") issues.push("question text is required");
  if (question.criteria.trim() === "") issues.push("question criteria are required");
  if (question.kind === "boolean") return issues;

  const options = question.kind === "choice" ? question.options : question.levels;
  const ids = options.map((option) => option.id);
  if (new Set(ids).size !== ids.length) issues.push("option ids must be distinct");
  const thresholdMode = question.kind === "choice" && question.abstention === "threshold";
  if (!thresholdMode) {
    if (!ids.includes(INSUFFICIENT_EVIDENCE)) issues.push(`options must include ${INSUFFICIENT_EVIDENCE}`);
    if (question.kind === "choice" && !ids.includes(NONE_OPTION)) {
      issues.push(`choice options must include ${NONE_OPTION}`);
    }
  } else if (ids.includes(INSUFFICIENT_EVIDENCE) || ids.includes(NONE_OPTION)) {
    issues.push("threshold questions must not offer abstention options");
  }
  if (options.length < 2) issues.push("at least two options are required");
  return issues;
}

function inUnitRange(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function distributionIssues(
  where: string,
  probabilities: Readonly<Record<string, number>>,
  allowed: readonly string[],
): string[] {
  const issues: string[] = [];
  const keys = Object.keys(probabilities);
  for (const key of keys) {
    if (!allowed.includes(key)) issues.push(`${where}: unknown option ${JSON.stringify(key)}`);
  }
  for (const id of allowed) {
    const value = probabilities[id];
    if (value === undefined) {
      issues.push(`${where}: missing probability for ${JSON.stringify(id)}`);
    } else if (!inUnitRange(value)) {
      issues.push(`${where}: probability for ${JSON.stringify(id)} is out of range`);
    }
  }
  const sum = allowed.reduce((total, id) => total + (probabilities[id] ?? 0), 0);
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) issues.push(`${where}: probabilities must sum to 1`);
  return issues;
}

// Checks that an answer matches its question: same question id and kind, options
// drawn from the question, and probabilities in range. Returns all issues found.
export function answerIssues(question: DecisionQuestion, answer: DecisionAnswer): string[] {
  const issues: string[] = [];
  if (answer.questionId !== question.id) issues.push("answer belongs to a different question");
  if (answer.kind !== question.kind) issues.push(`answer kind ${answer.kind} does not match question kind ${question.kind}`);
  if (!inUnitRange(answer.confidence)) issues.push("confidence is out of range");
  if (issues.length > 0) return issues;

  if (answer.kind === "boolean" && question.kind === "boolean") {
    if (!inUnitRange(answer.probabilityYes)) issues.push("probability of yes is out of range");
    if (answer.answer === "yes" && answer.probabilityYes < 0.5) issues.push("answer yes contradicts its probability");
    if (answer.answer === "no" && answer.probabilityYes >= 0.5) issues.push("answer no contradicts its probability");
  } else if (answer.kind === "choice" && question.kind === "choice") {
    const allowed = question.options.map((option) => option.id);
    if (!allowed.includes(answer.selected)) issues.push("selected option is not part of the question");
    issues.push(...distributionIssues("choice probabilities", answer.probabilities, allowed));
    if (answer.probabilities[answer.selected] !== undefined && answer.selected !== argmax(answer.probabilities)) {
      issues.push("selected option is not the most probable one");
    }
  } else if (answer.kind === "score" && question.kind === "score") {
    const allowed = question.levels.map((level) => level.id);
    if (!allowed.includes(answer.level)) issues.push("level is not part of the question");
    issues.push(...distributionIssues("score probabilities", answer.probabilities, allowed));
    if (answer.probabilities[answer.level] !== undefined && answer.level !== argmax(answer.probabilities)) {
      issues.push("level is not the most probable one");
    }
  }
  return issues;
}

function argmax(probabilities: Readonly<Record<string, number>>): string | undefined {
  let best: string | undefined;
  let bestValue = -Infinity;
  for (const [key, value] of Object.entries(probabilities)) {
    if (value > bestValue) {
      best = key;
      bestValue = value;
    }
  }
  return best;
}

export function validateAnswer(question: DecisionQuestion, answer: DecisionAnswer): DecisionAnswer {
  const issues = [...questionIssues(question), ...answerIssues(question, answer)];
  if (issues.length > 0) throw new DecisionError(issues);
  return answer;
}
