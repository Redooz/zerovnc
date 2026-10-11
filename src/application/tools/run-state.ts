// Mutable state of one task run, shared by its tools and the loop. One instance per task.
// Freshness rules live here: any desktop input invalidates the current observation and
// advances the input version, so a verification taken before input can never pass.
import type { Observation } from "../../domain/perception/observation.ts";
import type { ToolStatus } from "./contract.ts";
import { screenKeyOf } from "../knowledge/knowledge.ts";

export interface PlanRecord {
  readonly goal: string;
  readonly steps: readonly string[];
  readonly completionConditions: readonly string[];
  readonly version: number;
}

export type ConditionLevel = "supported" | "partial" | "not_supported" | "insufficient_evidence";

export interface ConditionResult {
  readonly condition: string;
  readonly level: ConditionLevel;
}

// Evidence from verify_result. The loop decides whether it passes, and only when it is current.
export interface VerificationRecord {
  readonly observationId: string;
  readonly inputVersion: number;
  readonly planVersion: number;
  readonly results: readonly ConditionResult[];
}

export interface ProgressEntry {
  readonly tool: string;
  readonly status: ToolStatus;
  readonly message: string;
}

const MAX_PROGRESS_ENTRIES = 30;

export class TaskRunState {
  // Latest perceived observation, or null when it is stale or was never taken.
  observation: Observation | null = null;
  // Incremented by every desktop input.
  inputVersion = 0;
  plan: PlanRecord | null = null;
  planVersion = 0;
  verification: VerificationRecord | null = null;
  // Set by report_blocker; the loop ends the task as fallida.
  blocker: string | null = null;
  // Fingerprint of the screen the task started from; empty until the first observation.
  startScreenKey: string | null = null;
  // UI targets acted on, in order, as labels only. Becomes a note when the task is verified.
  readonly actedSubjects: string[] = [];
  private readonly log: ProgressEntry[] = [];

  // Called before any desktop input is sent, whether or not it succeeds.
  recordInput(): void {
    this.inputVersion += 1;
    this.observation = null;
  }

  setObservation(observation: Observation): void {
    this.observation = observation;
    if (this.startScreenKey === null) this.startScreenKey = screenKeyOf(observation);
  }

  // Records a successful action on a UI target. Refused or failed actions teach nothing.
  noteActed(subject: string): void {
    if (subject.trim() === "" || this.actedSubjects.at(-1) === subject) return;
    this.actedSubjects.push(subject);
  }

  setPlan(plan: Omit<PlanRecord, "version">): void {
    this.planVersion += 1;
    this.plan = { ...plan, version: this.planVersion };
  }

  // True when a verification exists for the current screen state and plan, whatever its verdict.
  verificationCurrent(): boolean {
    const v = this.verification;
    return v !== null && this.plan !== null && v.inputVersion === this.inputVersion && v.planVersion === this.planVersion;
  }

  // Conditions of the current verification that are not supported.
  unsupportedConditions(): readonly ConditionResult[] {
    return this.verification?.results.filter((r) => r.level !== "supported") ?? [];
  }

  // A verification counts only if no input happened after it and the plan has not changed.
  verificationPassed(): boolean {
    const v = this.verification;
    if (v === null || this.plan === null) return false;
    if (v.inputVersion !== this.inputVersion || v.planVersion !== this.planVersion) return false;
    return v.results.length > 0 && v.results.every((r) => r.level === "supported");
  }

  // Appends one tool outcome to the progress log, keeping only the most recent entries.
  note(entry: ProgressEntry): void {
    this.log.push(entry);
    if (this.log.length > MAX_PROGRESS_ENTRIES) this.log.splice(0, this.log.length - MAX_PROGRESS_ENTRIES);
  }

  get progress(): readonly ProgressEntry[] {
    return this.log;
  }
}
