// Shared grading vocabulary. `not_evaluated` is used whenever evidence is
// missing; it never counts as a pass.
export type CheckOutcome = "pass" | "fail" | "not_evaluated";

export interface CheckResult {
  readonly name: string;
  readonly outcome: CheckOutcome;
  readonly detail: string;
}

export type Verdict = "pass" | "fail" | "not_evaluated";

export function verdictOf(checks: readonly CheckResult[]): Verdict {
  if (checks.some((check) => check.outcome === "fail")) return "fail";
  if (checks.some((check) => check.outcome === "not_evaluated")) return "not_evaluated";
  return "pass";
}
