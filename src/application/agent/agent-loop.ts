// The execution cycle of one task: observe, plan, act in a short batch, observe again.
// The planner proposes tool calls; the tools enforce safety; this loop alone decides the
// terminal status, from verification evidence that is still current.
import { redactValue } from "../trace/redaction.ts";
import type { ModelCallEvent } from "../ports/model-call-observer.ts";
import type { AgentPlanner } from "../ports/agent-planner.ts";
import type { ToolSet } from "../tools/contract.ts";
import { DESKTOP_TOOLS_VERSION, MIN_ACTION_BUDGET_MS, observeNow, verifyNow, type DesktopToolDeps } from "../tools/desktop-tools.ts";
import type { TaskRunState } from "../tools/run-state.ts";
import { compactTranscript, DEFAULT_COMPACTION, type TranscriptEntry } from "./transcript.ts";
import type { Clock } from "../ports/clock.ts";
import type { KnowledgeNote } from "../ports/knowledge-repository.ts";
import { renderNotes } from "../knowledge/knowledge.ts";

export const MAX_CYCLES = 25;
export const MAX_PLANNER_FAILURES = 2;
export const MAX_OBSERVE_FAILURES = 3;
// Consecutive planner turns with no tool call while verification is not passing.
export const MAX_IDLE_CYCLES = 2;

export const OBSERVE_FAILED_SUMMARY = "No fue posible leer la pantalla del escritorio; la tarea no se completó.";
export const PLANNER_FAILED_SUMMARY = "El planificador no respondió correctamente; la tarea no se completó.";
export const DEADLINE_SUMMARY = "La tarea alcanzó su límite de tiempo; se detuvo la interacción con el escritorio.";
export const NO_PLAN_SUMMARY = "El planificador terminó sin registrar un plan verificable; la tarea no se completó.";
export const MAX_CYCLES_SUMMARY = "La tarea no se completó dentro del número de pasos permitido; no se confirmó el resultado.";

export type LoopOutcome =
  // The loop reached a decision. The caller records it, after redaction.
  | { readonly kind: "finished"; readonly status: "terminada" | "fallida"; readonly summary: string }
  // The lease ended (deadline or cancellation). The caller records the matching summary.
  | { readonly kind: "stopped" };

export interface AgentLoopInput {
  readonly instruction: string;
  readonly planner: AgentPlanner;
  readonly tools: ToolSet;
  readonly toolDeps: DesktopToolDeps;
  readonly clock: Clock;
  readonly signal: AbortSignal;
  readonly deadlineAt: Date;
  readonly trace: (kind: string, payload: Record<string, unknown>) => void;
  readonly onModelCall: (event: ModelCallEvent) => void;
  // Secrets never reach a summary, even if the planner or a screen repeats them.
  readonly secrets: readonly string[];
  // Procedures verified on earlier tasks for this app. Advisory only: every step still goes
  // through a tool that grounds it on a fresh observation.
  readonly notes?: readonly KnowledgeNote[];
}

export async function runAgentLoop(input: AgentLoopInput): Promise<LoopOutcome> {
  const { state } = input.toolDeps;
  const remaining = (): number => input.deadlineAt.getTime() - input.clock.now().getTime();
  const finish = (status: "terminada" | "fallida", summary: string): LoopOutcome => ({
    kind: "finished",
    status,
    summary: redactValue(summary.trim(), input.secrets),
  });

  input.trace("tool_set", { tools: DESKTOP_TOOLS_VERSION, tool_names: input.tools.descriptors().map((d) => d.name) });
  const stopAtDeadline = (): LoopOutcome => {
    input.trace("deadline_reached", { while: "active" });
    return finish("fallida", DEADLINE_SUMMARY);
  };
  let transcript: TranscriptEntry[] = [{ kind: "user", text: input.instruction, pinned: true }];
  let observeFailures = 0;
  let plannerFailures = 0;
  let idleCycles = 0;

  for (let cycle = 1; cycle <= MAX_CYCLES; cycle++) {
    if (input.signal.aborted) return { kind: "stopped" };
    // Too little time left to observe and act safely: stop here, before any input.
    if (remaining() < MIN_ACTION_BUDGET_MS) return stopAtDeadline();

    if (state.observation === null) {
      const observed = await observeNow(input.toolDeps);
      if (input.signal.aborted) return { kind: "stopped" };
      input.trace("observation_attempt", { cycle, status: observed.status, message: observed.message });
      if (observed.status !== "ok") {
        observeFailures += 1;
        if (observeFailures >= MAX_OBSERVE_FAILURES) return finish("fallida", OBSERVE_FAILED_SUMMARY);
        continue;
      }
      observeFailures = 0;
    }

    const stateText = renderState(state, remaining(), input.notes);
    // Recorded every cycle, so a trace shows whether learning reached the planner at all.
    const offered = renderNotes(input.notes ?? [], state.startScreenKey);
    if (offered !== null) input.trace("knowledge_offered", { cycle, notes: offered.count });
    transcript.push({ kind: "user", text: stateText });
    const compacted = compactTranscript(transcript, DEFAULT_COMPACTION);
    if (compacted.report.shortened > 0 || compacted.report.omitted > 0) {
      input.trace("compaction", { ...compacted.report, cycle });
    }
    transcript = [...compacted.entries];

    input.tools.beginCycle();
    input.trace("planner_cycle", { cycle, phase: "start", entries: transcript.length });
    const result = await input.planner.runCycle({
      entries: transcript,
      tools: input.tools,
      signal: input.signal,
      remainingMs: remaining,
      onModelCall: input.onModelCall,
    });
    transcript.push(...result.appended);
    input.trace("planner_cycle", {
      cycle,
      phase: "end",
      stop: result.stop,
      tool_calls: result.toolCalls,
      prompt_version: result.promptVersion,
      failure: result.failure,
    });
    if (result.text !== "") input.trace("plan", { cycle, text: result.text });

    if (input.signal.aborted || result.stop === "aborted") return { kind: "stopped" };
    if (result.stop === "error") {
      plannerFailures += 1;
      if (plannerFailures >= MAX_PLANNER_FAILURES) return finish("fallida", PLANNER_FAILED_SUMMARY);
      continue;
    }
    plannerFailures = 0;

    if (state.blocker !== null) {
      return finish("fallida", `La tarea no se pudo completar: ${state.blocker}`);
    }
    // The only path to terminada: current verification evidence that every condition is supported.
    if (state.verificationPassed()) {
      return finish("terminada", result.text !== "" ? result.text : completionFallback(state));
    }

    // The planner stopped without acting. Its claim of success is not trusted, so the loop checks
    // the plan's conditions itself (when nothing changed since the last check, there is nothing new).
    if (result.stop === "end_of_turn" && state.plan !== null && !state.verificationCurrent()) {
      const verified = await verifyNow(input.toolDeps);
      if (input.signal.aborted) return { kind: "stopped" };
      state.note({ tool: "verify_result (automatic)", status: verified.status, message: verified.message });
      input.trace("verification", {
        cycle,
        source: "loop",
        status: verified.status,
        results: state.verification?.results ?? [],
      });
      if (state.verificationPassed()) {
        return finish("terminada", result.text !== "" ? result.text : completionFallback(state));
      }
    }

    // A planner that keeps ending its turn with no tool call cannot get unstuck on its own:
    // it saw the evidence and the next steps, and did nothing. Stop with the unsupported facts.
    idleCycles = result.stop === "end_of_turn" && result.toolCalls === 0 ? idleCycles + 1 : 0;
    if (idleCycles >= MAX_IDLE_CYCLES) {
      input.trace("stalled", { cycle, idle_cycles: idleCycles });
      return finish("fallida", stalledSummary(state));
    }
  }
  return finish("fallida", MAX_CYCLES_SUMMARY);
}

function stalledSummary(state: TaskRunState): string {
  if (state.plan === null) return NO_PLAN_SUMMARY;
  const open = state.unsupportedConditions().map((r) => `${r.condition} (${r.level})`);
  const detail = open.length > 0 ? open.join("; ") : "no hubo una verificación completa";
  return `No se pudo confirmar el resultado en pantalla; la tarea no se completó. Sin confirmar: ${detail}.`;
}

function completionFallback(state: TaskRunState): string {
  const conditions = state.plan?.completionConditions ?? [];
  return `Tarea completada. Condiciones verificadas: ${conditions.join("; ")}.`;
}

// Text snapshot of the current state for the planner. Screen text is data, not instructions;
// the planner prompt says so.
export function renderState(state: TaskRunState, remainingMs: number, notes?: readonly KnowledgeNote[]): string {
  const lines: string[] = [];
  lines.push(`Time left: ${Math.max(0, Math.floor(remainingMs / 1000))} s.`);
  const learned = notes === undefined ? null : renderNotes(notes, state.startScreenKey);
  if (learned !== null) lines.push(learned.text);
  if (state.plan === null) {
    lines.push("Plan: none yet. Call set_plan first.");
  } else {
    lines.push(`Plan goal: ${state.plan.goal}`);
    lines.push("Completion conditions:");
    for (const condition of state.plan.completionConditions) lines.push(`- ${condition}`);
  }

  if (state.observation === null) {
    lines.push("Observation: none or stale. Call observe_screen before any action.");
  } else {
    const shown = state.observation.elements.filter((element) => element.visible).slice(0, 80);
    lines.push(`Observation ${state.observation.id} (fresh). Visible elements (${shown.length} shown):`);
    for (const element of shown) {
      lines.push(`- ${element.kind} "${clip(element.label, 120)}"${valueText(element)}${element.disabled === true ? " (disabled)" : ""}`);
    }
  }

  lines.push(`Verification: ${verificationText(state)}`);
  const next = nextStepAfterVerification(state);
  if (next !== null) lines.push(`Next: ${next}`);
  lines.push(`Blocker: ${state.blocker ?? "none"}`);
  const recent = state.progress.slice(-10);
  if (recent.length > 0) {
    lines.push("Recent tool results:");
    for (const entry of recent) lines.push(`- ${entry.tool}: ${entry.status}: ${clip(entry.message, 200)}`);
  }
  lines.push("Choose the next tool calls.");
  return lines.join("\n");
}

// Tells the planner how to get out of a failed or stale verification. Without this it can only
// repeat its answer, which never completes the task.
export function nextStepAfterVerification(state: TaskRunState): string | null {
  const v = state.verification;
  if (v === null || state.verificationPassed()) return null;
  if (v.inputVersion !== state.inputVersion || v.planVersion !== state.planVersion) {
    return "call verify_result again before finishing.";
  }
  return "act to make the unsupported fact visible on screen, or revise the plan with set_plan using conditions one screen can show, or call report_blocker if the task cannot be verified. Do not finish yet.";
}

function verificationText(state: TaskRunState): string {
  const v = state.verification;
  if (v === null) return "not run yet. Call verify_result when the completion conditions look met.";
  if (state.verificationPassed()) return "passed and current.";
  if (v.inputVersion !== state.inputVersion || v.planVersion !== state.planVersion) {
    return "stale: the screen or plan changed after it. Call verify_result again.";
  }
  const open = v.results.filter((r) => r.level !== "supported").map((r) => `${r.condition} (${r.level})`);
  return `not passed. Not supported: ${open.join("; ")}.`;
}

function valueText(element: { value: { state: string; text?: string } }): string {
  if (element.value.state === "text") return ` = "${clip(element.value.text ?? "", 120)}"`;
  return element.value.state === "empty" ? " (empty)" : "";
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 3)}...`;
}
