// Component eval scoring. Pure functions over case results. Expected labels live
// only in the evaluator; the application never sees them. Development and held-out
// cases are scored separately and may never share a case id.

export type EvalSplit = "development" | "held_out";

export type CaseKind = "target" | "field" | "record" | "transition";

// What the evaluator expected, and what the system produced.
// reason "any" accepts any abstention reason.
// kind "error" is an outcome only (never an expectation): the call failed (provider,
// model, perception, malformed answer). A failure is not evidence that a target is
// missing, so it is never a correct abstention.
export type Expectation =
  | { readonly kind: "grounded"; readonly elementId: string }
  | { readonly kind: "abstain"; readonly reason: string }
  | { readonly kind: "error"; readonly reason: string };

// Abstention reasons that mean the system failed rather than judged.
export function isErrorReason(reason: string): boolean {
  return reason === "perception_failed" || reason === "model_failed" || reason === "invalid_answer" || reason === "unexpected" || reason.startsWith("model_");
}

export interface CaseResult {
  readonly caseId: string;
  readonly split: EvalSplit;
  readonly kind: CaseKind;
  readonly expected: Expectation;
  readonly actual: Expectation;
  readonly servedFallback: boolean;
  readonly latencyMs: number;
  readonly tokens: number;
  readonly costUsd: number;
}

export interface SplitMetrics {
  readonly cases: number;
  // Grounded expectations that were grounded to the right element.
  readonly targetRecall: number | null;
  // Grounded answers that matched the expected element (precision of grounding).
  readonly groundingPrecision: number | null;
  // Abstention expectations that were met by an abstention with the same reason.
  readonly abstentionCorrectness: number | null;
  // Fraction of all cases decided correctly (grounded to the right element, or abstained for the right reason).
  readonly decisionAccuracy: number;
  // Cases where the call failed (provider, model, perception, malformed answer).
  readonly errorRate: number;
  // Grounded answers that were wrong (wrong element, or any grounding when abstention was expected), over all cases.
  readonly wrongGroundingRate: number;
  readonly fallbackRate: number;
  readonly latencyP50Ms: number;
  readonly latencyP95Ms: number;
  readonly latencyMaxMs: number;
  readonly tokens: number;
  readonly costUsd: number;
}

export interface EvalMetrics {
  readonly development: SplitMetrics;
  readonly heldOut: SplitMetrics;
}

export class SplitLeakError extends Error {
  constructor(readonly caseIds: readonly string[]) {
    super(`case ids appear in both development and held-out sets: ${caseIds.join(", ")}`);
    this.name = "SplitLeakError";
  }
}

// Refuses to score when a case id is in both splits, so held-out results cannot be tuned on.
export function assertNoSplitLeak(results: readonly CaseResult[]): void {
  const dev = new Set(results.filter((r) => r.split === "development").map((r) => r.caseId));
  const leaked = [...new Set(results.filter((r) => r.split === "held_out" && dev.has(r.caseId)).map((r) => r.caseId))];
  if (leaked.length > 0) throw new SplitLeakError(leaked);
}

function isCorrect(result: CaseResult): boolean {
  const { expected, actual } = result;
  if (expected.kind === "grounded") return actual.kind === "grounded" && actual.elementId === expected.elementId;
  if (actual.kind === "error") return false;
  return actual.kind === "abstain" && (expected.reason === "any" || actual.reason === expected.reason);
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

export function computeSplitMetrics(results: readonly CaseResult[]): SplitMetrics {
  const grounded = results.filter((r) => r.expected.kind === "grounded");
  const abstain = results.filter((r) => r.expected.kind === "abstain");
  const answered = results.filter((r) => r.actual.kind === "grounded");
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  return {
    cases: results.length,
    targetRecall: ratio(grounded.filter(isCorrect).length, grounded.length),
    groundingPrecision: ratio(answered.filter((r) => r.expected.kind === "grounded" && isCorrect(r)).length, answered.length),
    abstentionCorrectness: ratio(abstain.filter(isCorrect).length, abstain.length),
    decisionAccuracy: ratio(results.filter(isCorrect).length, results.length) ?? 0,
    errorRate: ratio(results.filter((r) => r.actual.kind === "error").length, results.length) ?? 0,
    wrongGroundingRate: ratio(answered.filter((r) => !isCorrect(r)).length, results.length) ?? 0,
    fallbackRate: ratio(results.filter((r) => r.servedFallback).length, results.length) ?? 0,
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    latencyMaxMs: latencies.at(-1) ?? 0,
    tokens: results.reduce((total, r) => total + r.tokens, 0),
    costUsd: results.reduce((total, r) => total + r.costUsd, 0),
  };
}

export function computeMetrics(results: readonly CaseResult[]): EvalMetrics {
  assertNoSplitLeak(results);
  return {
    development: computeSplitMetrics(results.filter((r) => r.split === "development")),
    heldOut: computeSplitMetrics(results.filter((r) => r.split === "held_out")),
  };
}

export interface ConfigSummary {
  readonly name: string;
  readonly metrics: SplitMetrics;
}

export interface WinnerCriteria {
  // Configurations within this distance of the best accuracy/abstention qualify on speed.
  readonly tolerance: number;
  // Floors a configuration must meet to be recommended at all.
  readonly minAccuracy: number;
  readonly maxErrorRate: number;
  readonly maxWrongGroundingRate: number;
}

export const DEFAULT_WINNER_CRITERIA: WinnerCriteria = {
  tolerance: 0.05,
  minAccuracy: 0.8,
  maxErrorRate: 0.1,
  maxWrongGroundingRate: 0.1,
};

// Selection rule: only configurations that meet the correctness floors are eligible;
// among those within `tolerance` of the best accuracy and abstention correctness, pick
// the lowest p50 latency. Returns null when no configuration is eligible: a fast
// configuration that is not correct is never recommended.
export function selectWinner(configs: readonly ConfigSummary[], criteria: Partial<WinnerCriteria> = {}): ConfigSummary | null {
  const c = { ...DEFAULT_WINNER_CRITERIA, ...criteria };
  const eligible = configs.filter(
    (cfg) =>
      cfg.metrics.cases > 0 &&
      cfg.metrics.decisionAccuracy >= c.minAccuracy &&
      cfg.metrics.errorRate <= c.maxErrorRate &&
      cfg.metrics.wrongGroundingRate <= c.maxWrongGroundingRate,
  );
  if (eligible.length === 0) return null;
  const bestAccuracy = Math.max(...eligible.map((cfg) => cfg.metrics.decisionAccuracy));
  const bestAbstention = Math.max(...eligible.map((cfg) => cfg.metrics.abstentionCorrectness ?? 1));
  const qualifying = eligible.filter(
    (cfg) =>
      cfg.metrics.decisionAccuracy >= bestAccuracy - c.tolerance &&
      (cfg.metrics.abstentionCorrectness ?? 1) >= bestAbstention - c.tolerance,
  );
  return qualifying.reduce((fastest, cfg) => (cfg.metrics.latencyP50Ms < fastest.metrics.latencyP50Ms ? cfg : fastest));
}
