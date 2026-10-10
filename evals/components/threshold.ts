// Threshold sweep for threshold-mode decisions. A live run records, per case and
// config, the top candidate's probability and whether it lies in the labeled box.
// Abstaining below a threshold is then applied offline, so one set of live calls
// yields every threshold.
import { isErrorReason, type CaseResult, type Expectation } from "./metrics.ts";

export interface RawAnswer {
  readonly caseId: string;
  readonly split: "development" | "held_out";
  readonly expectedGrounded: boolean;
  // Probability of the chosen candidate; null when the model produced no answer.
  readonly probability: number | null;
  // Lead of the chosen candidate over the runner-up; null when unknown or single candidate.
  readonly margin: number | null;
  readonly inBox: boolean;
  // Abstention reason when the call failed before an answer (perception or model failure).
  readonly failure: string | null;
  // Diagnostics: the chosen candidate's label and any failure detail. Not used for scoring.
  readonly chosen: string | null;
  readonly detail: string | null;
  readonly latencyMs: number;
  readonly tokens: number;
  readonly costUsd: number;
  readonly servedFallback: boolean;
  readonly kind: "target" | "field";
}

export const SWEEP_THRESHOLDS: readonly number[] = Array.from({ length: 19 }, (_, i) => Math.round((i + 1) * 5) / 100);

// Applies a threshold to one raw answer and returns the case result it implies.
export function applyThreshold(raw: RawAnswer, threshold: number, minMargin = 0): CaseResult {
  const expected: Expectation = raw.expectedGrounded ? { kind: "grounded", elementId: "in-box" } : { kind: "abstain", reason: "any" };
  let actual: Expectation;
  if (raw.failure !== null) {
    // A failed call is an error; a code-level abstention (no candidates, too many) is a judgment.
    actual = isErrorReason(raw.failure) ? { kind: "error", reason: raw.failure } : { kind: "abstain", reason: raw.failure };
  } else if (raw.probability === null || raw.probability < threshold) {
    actual = { kind: "abstain", reason: "below_threshold" };
  } else if (raw.margin !== null && raw.margin < minMargin) {
    actual = { kind: "abstain", reason: "ambiguous_margin" };
  } else {
    actual = { kind: "grounded", elementId: raw.inBox ? "in-box" : "out" };
  }
  return {
    caseId: raw.caseId,
    split: raw.split,
    kind: raw.kind,
    expected,
    actual,
    servedFallback: raw.servedFallback,
    latencyMs: raw.latencyMs,
    tokens: raw.tokens,
    costUsd: raw.costUsd,
  };
}

// Decision accuracy for each sweep threshold over the given raw answers.
export function sweep(raws: readonly RawAnswer[]): { threshold: number; accuracy: number }[] {
  return SWEEP_THRESHOLDS.map((threshold) => {
    const correct = raws.filter((raw) => {
      const result = applyThreshold(raw, threshold);
      const actual = result.actual;
      if (raw.expectedGrounded) return actual.kind === "grounded" && actual.elementId === "in-box";
      return actual.kind === "abstain";
    }).length;
    return { threshold, accuracy: raws.length === 0 ? 0 : correct / raws.length };
  });
}

// Picks the threshold with the highest development accuracy. Ties go to the higher
// threshold, the more conservative choice, since a wrong grounding is the costlier error.
export function chooseThreshold(raws: readonly RawAnswer[]): { threshold: number; accuracy: number } {
  const points = sweep(raws);
  let best = points[0]!;
  for (const point of points) {
    if (point.accuracy >= best.accuracy) best = point;
  }
  return best;
}

export const SWEEP_MARGINS: readonly number[] = [0, 0.1, 0.2, 0.3, 0.4];

export interface Calibration {
  readonly threshold: number;
  readonly minMargin: number;
  readonly accuracy: number;
}

function isCorrectAt(raw: RawAnswer, threshold: number, minMargin: number): boolean {
  const actual = applyThreshold(raw, threshold, minMargin).actual;
  if (raw.expectedGrounded) return actual.kind === "grounded" && actual.elementId === "in-box";
  return actual.kind === "abstain";
}

// Every (threshold, margin) pair with its accuracy over the given raw answers.
export function sweepGrid(raws: readonly RawAnswer[]): Calibration[] {
  const grid: Calibration[] = [];
  for (const minMargin of SWEEP_MARGINS) {
    for (const threshold of SWEEP_THRESHOLDS) {
      const correct = raws.filter((raw) => isCorrectAt(raw, threshold, minMargin)).length;
      grid.push({ threshold, minMargin, accuracy: raws.length === 0 ? 0 : correct / raws.length });
    }
  }
  return grid;
}

// Highest development accuracy. Many pairs usually tie, and the edge of that plateau is
// the least robust choice (a small shift in probabilities flips cases), so the pair
// nearest the plateau's center is chosen. Distances are measured in grid steps.
export function chooseCalibration(raws: readonly RawAnswer[]): Calibration {
  const grid = sweepGrid(raws);
  const bestAccuracy = Math.max(...grid.map((point) => point.accuracy));
  const plateau = grid.filter((point) => point.accuracy === bestAccuracy);
  const meanThreshold = plateau.reduce((t, p) => t + p.threshold, 0) / plateau.length;
  const meanMargin = plateau.reduce((t, p) => t + p.minMargin, 0) / plateau.length;
  const thresholdStep = SWEEP_THRESHOLDS[1]! - SWEEP_THRESHOLDS[0]!;
  const marginStep = SWEEP_MARGINS[1]! - SWEEP_MARGINS[0]!;
  const distance = (p: Calibration): number =>
    Math.hypot((p.threshold - meanThreshold) / thresholdStep, (p.minMargin - meanMargin) / marginStep);
  return plateau.reduce((best, point) => (distance(point) < distance(best) ? point : best));
}
