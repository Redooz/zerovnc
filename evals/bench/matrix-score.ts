// Scoring for the decision-only matrix. Pure: takes the rows a live run produced.
export interface MatrixRow {
  readonly model: string;
  readonly mode: "threshold" | "option";
  readonly caseId: string;
  readonly variant: "base" | "reversed" | "renamed";
  // What a correct system does: choose this label (position and id independent), or abstain.
  readonly expected: { readonly kind: "choose"; readonly label: string } | { readonly kind: "abstain" };
  // What it did. "chose" carries the candidate's label; "error" is a failed call.
  readonly outcome:
    | { readonly kind: "chose"; readonly label: string; readonly probability: number | null; readonly margin: number | null }
    | { readonly kind: "abstained"; readonly reason: string }
    | { readonly kind: "error"; readonly reason: string };
}

export interface MatrixSummary {
  readonly model: string;
  readonly mode: string;
  readonly rows: number;
  readonly correct: number;
  readonly wrongChoice: number;
  readonly wrongAbstention: number;
  readonly errors: number;
  // Cases where the answer changed between base, reversed order, and renamed ids.
  readonly unstableCases: readonly string[];
  // Lowest probability/margin among correct choices vs highest among wrong or should-abstain choices.
  readonly lowestCorrectProbability: number | null;
  readonly highestWrongProbability: number | null;
  readonly lowestCorrectMargin: number | null;
  readonly highestWrongMargin: number | null;
  // True when some probability threshold (or margin) separates every correct choice from every wrong one.
  readonly separableByProbability: boolean | null;
  readonly separableByMargin: boolean | null;
}

function isCorrect(row: MatrixRow): boolean {
  if (row.outcome.kind === "error") return false;
  if (row.expected.kind === "abstain") return row.outcome.kind === "abstained";
  return row.outcome.kind === "chose" && row.outcome.label === row.expected.label;
}

function separable(correct: readonly number[], wrong: readonly number[]): boolean | null {
  if (correct.length === 0 || wrong.length === 0) return null;
  return Math.min(...correct) > Math.max(...wrong);
}

export function summarizeMatrix(rows: readonly MatrixRow[]): MatrixSummary[] {
  const groups = new Map<string, MatrixRow[]>();
  for (const row of rows) {
    const key = `${row.model}|${row.mode}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0]!;
    const correctChoices = group.filter((r) => isCorrect(r) && r.outcome.kind === "chose");
    // Choices that would be a wrong grounding: wrong label, or any choice where abstention was expected.
    const wrongChoices = group.filter((r) => r.outcome.kind === "chose" && !isCorrect(r));
    const pick = (rs: MatrixRow[], field: "probability" | "margin"): number[] =>
      rs.flatMap((r) => (r.outcome.kind === "chose" && r.outcome[field] !== null ? [r.outcome[field] as number] : []));
    const byCase = new Map<string, Set<string>>();
    for (const r of group) {
      const answer = r.outcome.kind === "chose" ? `chose:${r.outcome.label}` : r.outcome.kind === "abstained" ? "abstained" : "error";
      byCase.set(r.caseId, (byCase.get(r.caseId) ?? new Set()).add(answer));
    }
    const lowest = (values: number[]) => (values.length === 0 ? null : Math.min(...values));
    const highest = (values: number[]) => (values.length === 0 ? null : Math.max(...values));
    return {
      model: first.model,
      mode: first.mode,
      rows: group.length,
      correct: group.filter(isCorrect).length,
      wrongChoice: wrongChoices.length,
      wrongAbstention: group.filter((r) => r.expected.kind === "choose" && r.outcome.kind === "abstained").length,
      errors: group.filter((r) => r.outcome.kind === "error").length,
      unstableCases: [...byCase.entries()].filter(([, answers]) => answers.size > 1).map(([id]) => id),
      lowestCorrectProbability: lowest(pick(correctChoices, "probability")),
      highestWrongProbability: highest(pick(wrongChoices, "probability")),
      lowestCorrectMargin: lowest(pick(correctChoices, "margin")),
      highestWrongMargin: highest(pick(wrongChoices, "margin")),
      separableByProbability: separable(pick(correctChoices, "probability"), pick(wrongChoices, "probability")),
      separableByMargin: separable(pick(correctChoices, "margin"), pick(wrongChoices, "margin")),
    };
  });
}
