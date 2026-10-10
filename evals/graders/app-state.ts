import type { CheckResult } from "./result.ts";

// Result of POST /__check on the desktop. `unavailable` means no evidence.
export type AppStateEvidence =
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "checked"; readonly pass: boolean; readonly checks: readonly { nombre: string; ok: boolean }[] };

export function gradeAppState(evidence: AppStateEvidence): CheckResult {
  if (evidence.kind === "unavailable") {
    return { name: "estado de la app", outcome: "not_evaluated", detail: evidence.reason };
  }
  const failed = evidence.checks.filter((check) => !check.ok).map((check) => check.nombre);
  if (evidence.pass && failed.length === 0) {
    return { name: "estado de la app", outcome: "pass", detail: "all app-state checks passed" };
  }
  return {
    name: "estado de la app",
    outcome: "fail",
    detail: failed.length > 0 ? `failed: ${failed.join(", ")}` : "checker reported pass=false",
  };
}
