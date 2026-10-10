import type { PracticeFixture } from "../fixtures.ts";
import type { AppStateEvidence } from "./app-state.ts";
import { gradeAppState } from "./app-state.ts";
import { gradeAnswer } from "./answer.ts";
import { gradeFailureReasons } from "./failure-reasons.ts";
import { gradeSecretLeak } from "./secrets.ts";
import { gradeStatus } from "./status.ts";
import { verdictOf, type CheckResult, type Verdict } from "./result.ts";

export interface AgentOutcome {
  readonly estado: string;
  readonly resumen: string;
}

export interface GradedRun {
  readonly verdict: Verdict;
  readonly checks: readonly CheckResult[];
}

// Combines every deterministic grader. Summary-based checks run even if the
// app-state evidence is missing, so the report still shows what was observed.
export function gradeRun(
  fixture: PracticeFixture,
  outcome: AgentOutcome,
  evidence: AppStateEvidence,
  secrets: readonly string[],
): GradedRun {
  const checks: CheckResult[] = [
    gradeStatus(fixture.estado_esperado, outcome.estado),
    gradeAppState(evidence),
    gradeAnswer(fixture.respuesta_esperada, outcome.resumen),
    gradeFailureReasons(fixture.claves_razon, outcome.resumen),
    gradeSecretLeak(outcome.resumen, secrets),
  ];
  return { verdict: verdictOf(checks), checks };
}
