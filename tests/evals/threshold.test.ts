import { describe, expect, test } from "bun:test";
import { applyThreshold, chooseThreshold, sweep, type RawAnswer } from "../../evals/components/threshold.ts";

const raw = (over: Partial<RawAnswer>): RawAnswer => ({
  caseId: "c",
  split: "development",
  expectedGrounded: true,
  probability: 0.9,
  margin: null,
  inBox: true,
  failure: null,
  chosen: null,
  detail: null,
  latencyMs: 100,
  tokens: 10,
  costUsd: 0.001,
  servedFallback: false,
  kind: "target",
  ...over,
});

describe("threshold application", () => {
  test("a probability below the threshold abstains; at or above it grounds", () => {
    expect(applyThreshold(raw({ probability: 0.4 }), 0.5).actual).toEqual({ kind: "abstain", reason: "below_threshold" });
    expect(applyThreshold(raw({ probability: 0.5 }), 0.5).actual).toEqual({ kind: "grounded", elementId: "in-box" });
  });

  test("a failed call is an error for any threshold, not an abstention", () => {
    expect(applyThreshold(raw({ probability: null, failure: "perception_failed", inBox: false }), 0.05).actual).toEqual({ kind: "error", reason: "perception_failed" });
    expect(applyThreshold(raw({ probability: null, failure: "model_provider", inBox: false }), 0.05).actual).toEqual({ kind: "error", reason: "model_provider" });
  });

  test("a code-level abstention (no candidates) stays an abstention", () => {
    expect(applyThreshold(raw({ probability: null, failure: "no_candidates", inBox: false }), 0.5).actual).toEqual({ kind: "abstain", reason: "no_candidates" });
  });

  test("a wrong candidate that is grounded counts as wrong", () => {
    const result = applyThreshold(raw({ inBox: false }), 0.5);
    expect(result.actual).toEqual({ kind: "grounded", elementId: "out" });
  });
});

describe("threshold sweep", () => {
  test("accuracy rises when weak wrong answers are abstained on", () => {
    const raws = [
      raw({ caseId: "g1", probability: 0.95, inBox: true }),
      raw({ caseId: "g2", probability: 0.3, inBox: false, expectedGrounded: true }),
      raw({ caseId: "a1", probability: 0.2, expectedGrounded: false, inBox: false }),
    ];
    const at = (t: number) => sweep(raws).find((p) => Math.abs(p.threshold - t) < 1e-9)!.accuracy;
    expect(at(0.05)).toBeCloseTo(1 / 3);
    expect(at(0.5)).toBeCloseTo(2 / 3);
  });

  test("ties go to the higher, more conservative threshold", () => {
    const raws = [raw({ probability: 0.99, inBox: true })];
    expect(chooseThreshold(raws).threshold).toBe(0.95);
  });
});

describe("margin calibration", () => {
  test("a near-tie abstains on margin even when the probability clears the threshold", () => {
    expect(applyThreshold(raw({ probability: 0.52, margin: 0.04 }), 0.5, 0.3).actual).toEqual({ kind: "abstain", reason: "ambiguous_margin" });
    expect(applyThreshold(raw({ probability: 0.8, margin: 0.6 }), 0.5, 0.3).actual).toEqual({ kind: "grounded", elementId: "in-box" });
  });

  test("calibration picks a margin that separates correct answers from near-ties", async () => {
    const { chooseCalibration } = await import("../../evals/components/threshold.ts");
    const raws = [
      raw({ caseId: "ok1", probability: 0.7, margin: 0.5, inBox: true }),
      raw({ caseId: "ok2", probability: 0.8, margin: 0.6, inBox: true }),
      // Duplicates: high-ish probability but nearly tied, and a grounding would be wrong to trust.
      raw({ caseId: "dup", expectedGrounded: false, probability: 0.55, margin: 0.05, inBox: false }),
    ];
    const chosen = chooseCalibration(raws);
    expect(chosen.accuracy).toBe(1);
    expect(chosen.minMargin).toBeGreaterThan(0.05);
  });
});

describe("calibration tie-breaking", () => {
  test("when every pair is perfect, the center of the plateau is chosen, not its edge", async () => {
    const { chooseCalibration } = await import("../../evals/components/threshold.ts");
    const raws = [raw({ caseId: "a", probability: 0.99, margin: 0.98 }), raw({ caseId: "b", probability: 0.97, margin: 0.95 })];
    const chosen = chooseCalibration(raws);
    expect(chosen.accuracy).toBe(1);
    expect(chosen.threshold).toBeGreaterThan(0.3);
    expect(chosen.threshold).toBeLessThan(0.7);
    expect(chosen.minMargin).toBeGreaterThan(0.05);
    expect(chosen.minMargin).toBeLessThan(0.35);
  });
});
