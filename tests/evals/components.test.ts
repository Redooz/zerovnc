import { describe, expect, test } from "bun:test";
import { assertNoSplitLeak, computeMetrics, SplitLeakError, type CaseResult } from "../../evals/components/metrics.ts";

const base = (over: Partial<CaseResult>): CaseResult => ({
  caseId: "c1",
  split: "development",
  kind: "target",
  expected: { kind: "grounded", elementId: "e2" },
  actual: { kind: "grounded", elementId: "e2" },
  servedFallback: false,
  latencyMs: 1000,
  tokens: 100,
  costUsd: 0.001,
  ...over,
});

describe("component metrics", () => {
  test("recall, precision, abstention, and accuracy are computed per split", () => {
    const results: CaseResult[] = [
      base({ caseId: "a" }),
      base({ caseId: "b", actual: { kind: "grounded", elementId: "e9" } }),
      base({ caseId: "c", expected: { kind: "abstain", reason: "no_match" }, actual: { kind: "abstain", reason: "no_match" } }),
      base({ caseId: "d", expected: { kind: "abstain", reason: "ambiguous" }, actual: { kind: "grounded", elementId: "e2" }, servedFallback: true }),
    ];
    const dev = computeMetrics(results).development;
    expect(dev.cases).toBe(4);
    expect(dev.targetRecall).toBe(0.5);
    expect(dev.groundingPrecision).toBeCloseTo(1 / 3);
    expect(dev.abstentionCorrectness).toBe(0.5);
    expect(dev.decisionAccuracy).toBe(0.5);
    expect(dev.fallbackRate).toBe(0.25);
    expect(dev.costUsd).toBeCloseTo(0.004);
  });

  test("a split with no grounded expectations reports null recall, not a perfect score", () => {
    const dev = computeMetrics([base({ expected: { kind: "abstain", reason: "no_match" }, actual: { kind: "abstain", reason: "no_match" } })]).development;
    expect(dev.targetRecall).toBeNull();
    expect(dev.abstentionCorrectness).toBe(1);
  });

  test("held-out cases are reported separately from development", () => {
    const metrics = computeMetrics([base({ caseId: "a" }), base({ caseId: "z", split: "held_out", actual: { kind: "grounded", elementId: "nope" } })]);
    expect(metrics.development.targetRecall).toBe(1);
    expect(metrics.heldOut.targetRecall).toBe(0);
  });

  test("a case id present in both splits is refused", () => {
    expect(() => assertNoSplitLeak([base({ caseId: "x" }), base({ caseId: "x", split: "held_out" })])).toThrow(SplitLeakError);
  });

  test("latency is reported as p50 and max", () => {
    const dev = computeMetrics([base({ caseId: "a", latencyMs: 100 }), base({ caseId: "b", latencyMs: 300 }), base({ caseId: "c", latencyMs: 200 })]).development;
    expect(dev.latencyP50Ms).toBe(200);
    expect(dev.latencyMaxMs).toBe(300);
  });
});

describe("abstention and selection rules", () => {
  test("an expected abstention with reason any accepts any abstention reason", () => {
    const dev = computeMetrics([base({ expected: { kind: "abstain", reason: "any" }, actual: { kind: "abstain", reason: "insufficient_evidence" } })]).development;
    expect(dev.abstentionCorrectness).toBe(1);
  });

  test("p95 latency is reported", () => {
    const latencies = Array.from({ length: 20 }, (_, i) => base({ caseId: `c${i}`, latencyMs: (i + 1) * 100 }));
    expect(computeMetrics(latencies).development.latencyP95Ms).toBe(1900);
  });

  const metricsOf = (decisionAccuracy: number, p50: number, over: Record<string, number> = {}) => ({
    cases: 10, targetRecall: null, groundingPrecision: null, abstentionCorrectness: 1, decisionAccuracy,
    errorRate: 0, wrongGroundingRate: 0,
    fallbackRate: 0, latencyP50Ms: p50, latencyP95Ms: p50, latencyMaxMs: p50, tokens: 0, costUsd: 0, ...over,
  });

  test("selection picks the fastest eligible configuration within tolerance of the best", async () => {
    const { selectWinner } = await import("../../evals/components/metrics.ts");
    const winner = selectWinner([
      { name: "a", metrics: metricsOf(0.95, 3000) },
      { name: "b", metrics: metricsOf(0.92, 1000) },
      { name: "c", metrics: metricsOf(0.5, 500) },
    ]);
    expect(winner?.name).toBe("b");
  });

  test("no configuration is recommended when none meets the correctness floors", async () => {
    const { selectWinner } = await import("../../evals/components/metrics.ts");
    expect(selectWinner([{ name: "fast-but-wrong", metrics: metricsOf(0.3, 100) }, { name: "also-wrong", metrics: metricsOf(0.4, 200) }])).toBeNull();
  });

  test("a configuration with a high error rate or wrong groundings is not eligible even if accurate", async () => {
    const { selectWinner } = await import("../../evals/components/metrics.ts");
    expect(selectWinner([{ name: "flaky", metrics: metricsOf(0.9, 100, { errorRate: 0.3 }) }])).toBeNull();
    expect(selectWinner([{ name: "reckless", metrics: metricsOf(0.9, 100, { wrongGroundingRate: 0.3 }) }])).toBeNull();
  });

  test("a failed call is an error, never a correct abstention", () => {
    const failed = base({
      caseId: "f",
      expected: { kind: "abstain", reason: "any" },
      actual: { kind: "error", reason: "model_provider" },
    });
    const dev = computeMetrics([failed]).development;
    expect(dev.abstentionCorrectness).toBe(0);
    expect(dev.decisionAccuracy).toBe(0);
    expect(dev.errorRate).toBe(1);
  });

  test("grounding when abstention was expected counts as a wrong grounding", () => {
    const wrong = base({ caseId: "w", expected: { kind: "abstain", reason: "any" }, actual: { kind: "grounded", elementId: "e1" } });
    expect(computeMetrics([wrong]).development.wrongGroundingRate).toBe(1);
  });
});
