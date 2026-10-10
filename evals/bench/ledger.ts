// Spend ledger for live benchmark runs. Enforces the Phase 3 cap across runs and
// the single-run rule for held-out confirmation. Pure logic over a JSON file.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const PHASE3_CAP_USD = 5;
// Spend before the benchmark existed (diagnostics and probes), counted conservatively.
export const PRIOR_SPEND_USD = 0.05;

export interface LedgerState {
  readonly capUsd: number;
  readonly spentUsd: number;
  readonly runs: readonly { readonly at: string; readonly split: string; readonly costUsd: number }[];
}

export class BudgetExceededError extends Error {
  constructor(readonly remainingUsd: number, readonly neededUsd: number) {
    super(`budget exceeded: US$${neededUsd.toFixed(4)} needed, US$${remainingUsd.toFixed(4)} remaining`);
    this.name = "BudgetExceededError";
  }
}

export function emptyLedger(): LedgerState {
  return { capUsd: PHASE3_CAP_USD, spentUsd: PRIOR_SPEND_USD, runs: [] };
}

export function remainingUsd(state: LedgerState): number {
  return state.capUsd - state.spentUsd;
}

// Throws before a call that could exceed the cap.
export function assertCanSpend(state: LedgerState, estimateUsd: number): void {
  if (estimateUsd > remainingUsd(state)) throw new BudgetExceededError(remainingUsd(state), estimateUsd);
}

export function addSpend(state: LedgerState, costUsd: number, split: string, at: string): LedgerState {
  return {
    ...state,
    spentUsd: state.spentUsd + costUsd,
    runs: [...state.runs, { at, split, costUsd }],
  };
}

export function loadLedger(path: string): LedgerState {
  if (!existsSync(path)) return emptyLedger();
  return JSON.parse(readFileSync(path, "utf8")) as LedgerState;
}

export function saveLedger(path: string, state: LedgerState): void {
  writeFileSync(path, JSON.stringify(state, null, 2));
}

// Held-out cases are confirmed once. A marker file records the first confirmation.
export function assertHeldOutAllowed(markerPath: string): void {
  if (existsSync(markerPath)) {
    throw new Error(`held-out split was already confirmed (${markerPath}); do not tune on it again`);
  }
}
