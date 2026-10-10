import { describe, expect, test } from "bun:test";
import { summarizeMatrix, type MatrixRow } from "../../evals/bench/matrix-score.ts";

const row = (over: Partial<MatrixRow>): MatrixRow => ({
  model: "jev",
  mode: "threshold",
  caseId: "c1",
  variant: "base",
  expected: { kind: "choose", label: "Guardar" },
  outcome: { kind: "chose", label: "Guardar", probability: 0.8, margin: 0.6 },
  ...over,
});

describe("matrix summary", () => {
  test("counts correct choices, wrong choices, wrong abstentions, and errors separately", () => {
    const [s] = summarizeMatrix([
      row({}),
      row({ caseId: "c2", outcome: { kind: "chose", label: "Cancelar", probability: 0.6, margin: 0.2 } }),
      row({ caseId: "c3", outcome: { kind: "abstained", reason: "none" } }),
      row({ caseId: "c4", outcome: { kind: "error", reason: "model_provider" } }),
      row({ caseId: "c5", expected: { kind: "abstain" }, outcome: { kind: "abstained", reason: "no_match" } }),
    ]);
    expect(s).toMatchObject({ rows: 5, correct: 2, wrongChoice: 1, wrongAbstention: 1, errors: 1 });
  });

  test("a failed call is never a correct abstention", () => {
    const [s] = summarizeMatrix([row({ expected: { kind: "abstain" }, outcome: { kind: "error", reason: "model_provider" } })]);
    expect(s?.correct).toBe(0);
    expect(s?.errors).toBe(1);
  });

  test("choosing anything where abstention was expected is a wrong choice", () => {
    const [s] = summarizeMatrix([row({ expected: { kind: "abstain" }, outcome: { kind: "chose", label: "Guardar", probability: 0.7, margin: 0.4 } })]);
    expect(s?.wrongChoice).toBe(1);
  });

  test("reports whether a probability threshold could separate right from wrong", () => {
    const rows = [
      row({ caseId: "a", outcome: { kind: "chose", label: "Guardar", probability: 0.9, margin: 0.8 } }),
      row({ caseId: "b", expected: { kind: "abstain" }, outcome: { kind: "chose", label: "Guardar", probability: 0.4, margin: 0.1 } }),
    ];
    expect(summarizeMatrix(rows)[0]).toMatchObject({ separableByProbability: true, separableByMargin: true });
    const overlapping = [
      row({ caseId: "a", outcome: { kind: "chose", label: "Guardar", probability: 0.5, margin: 0.2 } }),
      row({ caseId: "b", expected: { kind: "abstain" }, outcome: { kind: "chose", label: "Guardar", probability: 0.7, margin: 0.5 } }),
    ];
    expect(summarizeMatrix(overlapping)[0]).toMatchObject({ separableByProbability: false, separableByMargin: false });
  });

  test("flags a case whose answer changes with candidate order or ids", () => {
    const [s] = summarizeMatrix([
      row({ variant: "base" }),
      row({ variant: "reversed", outcome: { kind: "chose", label: "Cancelar", probability: 0.6, margin: 0.2 } }),
      row({ caseId: "stable", variant: "base" }),
      row({ caseId: "stable", variant: "renamed" }),
    ]);
    expect(s?.unstableCases).toEqual(["c1"]);
  });

  test("groups by model and mode", () => {
    const summaries = summarizeMatrix([row({}), row({ mode: "option" }), row({ model: "luna" })]);
    expect(summaries.map((s) => `${s.model}/${s.mode}`).sort()).toEqual(["jev/option", "jev/threshold", "luna/threshold"]);
  });
});
