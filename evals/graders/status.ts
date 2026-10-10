import type { CheckResult } from "./result.ts";

export function gradeStatus(expected: string, actual: string): CheckResult {
  const falseSuccess = actual === "terminada" && expected !== "terminada";
  const outcome = actual === expected ? "pass" : "fail";
  return {
    name: "estado",
    outcome,
    detail: falseSuccess
      ? `expected ${expected}, got terminada (false success)`
      : `expected ${expected}, got ${actual}`,
  };
}
