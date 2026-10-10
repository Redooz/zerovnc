import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addSpend, assertCanSpend, assertHeldOutAllowed, BudgetExceededError, emptyLedger, PHASE3_CAP_USD, remainingUsd } from "../../evals/bench/ledger.ts";

describe("spend ledger", () => {
  test("starts with the Phase 3 cap and a conservative prior-spend estimate", () => {
    expect(emptyLedger().capUsd).toBe(PHASE3_CAP_USD);
    expect(remainingUsd(emptyLedger())).toBeLessThan(PHASE3_CAP_USD);
  });

  test("a call that would exceed the cap is refused before it is made", () => {
    const start = emptyLedger();
    const state = addSpend(start, remainingUsd(start) - 0.001, "development", "t");
    expect(() => assertCanSpend(state, 0.5)).toThrow(BudgetExceededError);
    expect(() => assertCanSpend(state, 0.0005)).not.toThrow();
  });

  test("spend accumulates across runs", () => {
    const state = addSpend(addSpend(emptyLedger(), 0.1, "development", "a"), 0.2, "held_out", "b");
    expect(state.runs.map((r) => r.split)).toEqual(["development", "held_out"]);
    expect(state.spentUsd).toBeCloseTo(0.05 + 0.3);
  });

  test("held-out confirmation is refused once the marker exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    const marker = join(dir, "held-out-confirmed.json");
    expect(() => assertHeldOutAllowed(marker)).not.toThrow();
    writeFileSync(marker, "{}");
    expect(() => assertHeldOutAllowed(marker)).toThrow(/already confirmed/);
  });
});
