import { describe, expect, test } from "bun:test";
import { compactTranscript, transcriptChars, type TranscriptEntry } from "../../src/application/agent/transcript.ts";

const INSTRUCTION: TranscriptEntry = { kind: "user", text: "Registra a Ana Torres con teléfono 3157654321.", pinned: true };

// One planning cycle: a state snapshot, the planner's turn with a tool request, and the result.
function cycle(n: number, stateChars = 1_200, resultChars = 600): TranscriptEntry[] {
  const id = `call-${n}`;
  return [
    { kind: "user", text: `State ${n}\n${"Campo visible con datos largos. ".repeat(Math.ceil(stateChars / 33))}` },
    { kind: "assistant", text: `Plan de paso ${n}. ${"razonamiento ".repeat(20)}`, toolCalls: [{ id, name: "click_control", arguments: { control: `Control ${n}` } }] },
    { kind: "tool_result", toolCallId: id, toolName: "click_control", status: "ok", text: `resultado ${n} ${"detalle ".repeat(Math.ceil(resultChars / 8))}` },
  ];
}

// Invariants that must hold after every compaction.
function assertWellFormed(entries: readonly TranscriptEntry[]): void {
  const requested = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "assistant") for (const call of entry.toolCalls) requested.add(call.id);
    if (entry.kind === "tool_result") {
      // Every result has a request in front of it: no orphan results.
      expect(requested.has(entry.toolCallId)).toBe(true);
    }
  }
}

describe("compactTranscript", () => {
  test("leaves a transcript under budget untouched", () => {
    const entries = [INSTRUCTION, ...cycle(1), ...cycle(2)];
    const { entries: out, report } = compactTranscript(entries, { budgetChars: 1_000_000, keepRecent: 3 });
    expect(out).toEqual(entries);
    expect(report).toEqual({ beforeChars: transcriptChars(entries), afterChars: transcriptChars(entries), shortened: 0, omitted: 0 });
  });

  test("shortens older state, planner text, and tool results, but keeps the pinned instruction and the newest entries", () => {
    const history: TranscriptEntry[] = [INSTRUCTION];
    for (let n = 1; n <= 12; n++) history.push(...cycle(n));
    const budget = transcriptChars(history) - 4_000;
    const { entries, report } = compactTranscript(history, { budgetChars: budget, keepRecent: 6 });

    expect(report.shortened).toBeGreaterThan(0);
    expect(entries[0]).toEqual(INSTRUCTION);
    // The newest six entries are byte-for-byte unchanged.
    expect(entries.slice(-6)).toEqual(history.slice(-6));
    // An old state snapshot is now a short, marked summary.
    const oldState = entries.find((e) => e.kind === "user" && e.text.includes("State 2"));
    expect(oldState?.kind === "user" && oldState.text.startsWith("[earlier state, compacted]")).toBe(true);
    expect(report.afterChars).toBeLessThanOrEqual(budget);
    assertWellFormed(entries);
  });

  test("when shortening is not enough, whole old cycles are removed behind one note and no tool result is orphaned", () => {
    const history: TranscriptEntry[] = [INSTRUCTION];
    for (let n = 1; n <= 20; n++) history.push(...cycle(n, 4_000, 3_000));
    const budget = 20_000;
    const { entries, report } = compactTranscript(history, { budgetChars: budget, keepRecent: 6 });

    expect(report.omitted).toBeGreaterThan(0);
    expect(entries[0]).toEqual(INSTRUCTION);
    expect(entries.some((e) => e.kind === "user" && e.text.includes("earlier entries omitted"))).toBe(true);
    assertWellFormed(entries);
    expect(report.afterChars).toBeLessThanOrEqual(budget);
  });

  test("a long task stays within budget over 300 cycles and keeps its instruction and latest state", () => {
    const budget = 30_000;
    let transcript: TranscriptEntry[] = [INSTRUCTION];
    let maxAfter = 0;
    for (let n = 1; n <= 300; n++) {
      transcript.push(...cycle(n, 1_500, 800));
      const { entries, report } = compactTranscript(transcript, { budgetChars: budget, keepRecent: 8 });
      transcript = entries;
      maxAfter = Math.max(maxAfter, report.afterChars);
      expect(entries[0]).toEqual(INSTRUCTION);
      assertWellFormed(entries);
    }
    expect(maxAfter).toBeLessThanOrEqual(budget);
    // The most recent cycle is still present in full.
    const last = transcript.find((e) => e.kind === "user" && e.text.startsWith("State 300"));
    expect(last).toBeDefined();
  });

  test("planner tool results for set_plan and verify_result keep more text than ordinary results", () => {
    const planResult: TranscriptEntry = { kind: "tool_result", toolCallId: "p", toolName: "set_plan", status: "ok", text: "plan ".repeat(200) };
    const clickResult: TranscriptEntry = { kind: "tool_result", toolCallId: "c", toolName: "click_control", status: "ok", text: "click ".repeat(200) };
    const history: TranscriptEntry[] = [
      INSTRUCTION,
      { kind: "assistant", text: "", toolCalls: [{ id: "p", name: "set_plan", arguments: {} }] },
      planResult,
      { kind: "assistant", text: "", toolCalls: [{ id: "c", name: "click_control", arguments: {} }] },
      clickResult,
      ...Array.from({ length: 8 }, (_, i) => ({ kind: "user" as const, text: `recent ${i} ${"x".repeat(50)}` })),
    ];
    const { entries } = compactTranscript(history, { budgetChars: 1_500, keepRecent: 8 });
    const plan = entries.find((e) => e.kind === "tool_result" && e.toolName === "set_plan");
    const click = entries.find((e) => e.kind === "tool_result" && e.toolName === "click_control");
    expect(plan && plan.kind === "tool_result" ? plan.text.length : 0).toBeGreaterThan(click && click.kind === "tool_result" ? click.text.length : 0);
  });
});
