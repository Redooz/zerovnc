// Desktop tools for one task. Each tool is a closure over that task's executor, perception,
// grounding, and run state, so no state is shared between tasks. Safety rules live here:
// - acting tools need a fresh observation (the one they were grounded on, with no input since);
// - acting tools refuse when the task deadline is too close to finish the action;
// - ambiguous or unsupported targets are refused, never guessed;
// - every input advances the input version, which invalidates earlier verification.
import { z } from "zod";
import type { Clock } from "../ports/clock.ts";
import type { DesktopExecutor, ActionResult } from "../desktop/desktop-executor.ts";
import { keysymsForChord } from "../desktop/keysyms.ts";
import type { PerceiveScreen } from "../perception/perceive-screen.ts";
import type { GroundingService } from "../grounding/grounding-service.ts";
import type { ObservedElement } from "../../domain/perception/observation.ts";
import type { ConditionLevel, ConditionResult, TaskRunState } from "./run-state.ts";
import type { ToolDefinition, ToolResult } from "./contract.ts";
import type { TaskId } from "../../domain/tasks/task.ts";
import { ToolSet, type ToolInvocationRecord } from "./contract.ts";

// Remaining budget a single acting tool needs (before its input is sent).
export const MIN_ACTION_BUDGET_MS = 3_000;
// Budget kept back for reading the screen after a wait.
export const OBSERVATION_RESERVE_MS = 15_000;
export const WAIT_MAX_MS = 5_000;
export const WAIT_MIN_MS = 200;
export const MAX_SCROLL_STEPS = 10;

// Keys and chords the planner may press. Anything else is refused before it reaches the desktop.
export const SUPPORTED_KEYS = [
  "Return",
  "Enter",
  "Tab",
  "shift+Tab",
  "Escape",
  "BackSpace",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Up",
  "Down",
  "Left",
  "Right",
  "space",
  "ctrl+a",
] as const;

export interface DesktopToolDeps {
  readonly taskId: TaskId;
  readonly executor: DesktopExecutor;
  readonly perception: PerceiveScreen;
  readonly grounding: GroundingService;
  readonly state: TaskRunState;
  readonly clock: Clock;
  readonly deadlineAt: Date;
  // Lease signal: aborts at the task deadline or on cancellation.
  readonly signal: AbortSignal;
}

// Descriptions are model-facing prompt text; bump DESKTOP_TOOLS_VERSION when they change.
export const DESKTOP_TOOLS_VERSION = "desktop-tools.v2";

// Per-task tool set. Every outcome is noted in the run state (the planner sees recent results)
// and passed to `onInvocation` for tracing.
export function createTaskToolSet(
  deps: DesktopToolDeps,
  hooks: { readonly now: () => number; readonly onInvocation: (record: ToolInvocationRecord) => void },
): ToolSet {
  return new ToolSet(createDesktopTools(deps), {
    now: hooks.now,
    onInvocation: (record) => {
      deps.state.note({ tool: record.tool, status: record.status, message: record.message });
      hooks.onInvocation(record);
    },
  });
}

export function createDesktopTools(deps: DesktopToolDeps): ToolDefinition[] {
  return [
    observeScreenTool(deps),
    clickControlTool(deps),
    selectRecordTool(deps),
    replaceFieldTool(deps),
    scrollScreenTool(deps),
    pressKeyTool(deps),
    waitForScreenTool(deps),
    setPlanTool(deps),
    verifyResultTool(deps),
    reportBlockerTool(deps),
  ];
}

function remainingMs(deps: DesktopToolDeps): number {
  return deps.deadlineAt.getTime() - deps.clock.now().getTime();
}

function isFresh(deps: DesktopToolDeps): boolean {
  const observation = deps.state.observation;
  const latest = deps.executor.latestObservation;
  return observation !== null && latest !== null && latest.observationId === observation.id;
}

function freshnessRefusal(): ToolResult {
  return { status: "refused", message: "the observation is stale: call observe_screen before acting" };
}

function deadlineRefusal(): ToolResult {
  return { status: "refused", message: "the task deadline is too close; no action was taken" };
}

function ok(message: string, data?: Record<string, unknown>): ToolResult {
  return data === undefined ? { status: "ok", message } : { status: "ok", message, data };
}

// Captures a fresh observation after the repaint window, then perceives it.
// Updates the run state; the loop and other tools read the observation from there.
export async function observeNow(deps: DesktopToolDeps): Promise<ToolResult> {
  if (remainingMs(deps) < MIN_ACTION_BUDGET_MS) return deadlineRefusal();
  const screenshot = await deps.executor.observe();
  const outcome = await deps.perception.perceive({ taskId: deps.taskId, screenshot, signal: deps.signal });
  if (outcome.status === "abstained") {
    deps.state.observation = null;
    return { status: "failed", message: `the screen could not be read (${outcome.reason}); observe_screen again or wait` };
  }
  deps.state.setObservation(outcome.observation);
  const visible = outcome.observation.elements.filter((element) => element.visible).length;
  return ok(`observed the screen: ${visible} visible elements`, { observation_id: outcome.observation.id, visible_elements: visible });
}

// Interprets a batch of executor results. The first non-executed action ends the batch.
function fromBatch(results: readonly ActionResult[], success: string): ToolResult {
  const failure = results.find((result) => result.status !== "executed");
  if (failure === undefined) return ok(success);
  if (failure.status === "interrupted") return { status: "refused", message: `the action was interrupted: ${failure.reason ?? "stopped"}` };
  if (failure.status === "rejected") return { status: "refused", message: `the action was rejected: ${failure.reason ?? "rejected"}` };
  return { status: "failed", message: `the action failed: ${failure.reason ?? failure.status}` };
}

function centerOf(element: ObservedElement): { x: number; y: number } {
  return { x: Math.floor(element.box.x + element.box.w / 2), y: Math.floor(element.box.y + element.box.h / 2) };
}

// A successful action on a grounded control or field. `subject` is the label only.
function disabledRefusal(label: string): ToolResult {
  return { status: "refused", message: `"${label}" is disabled; nothing was clicked` };
}

function groundingRefusal(what: string, reason: string, detail: string): ToolResult {
  return { status: "refused", message: `no safe ${what} match (${reason}: ${detail}); nothing was clicked` };
}

function observeScreenTool(deps: DesktopToolDeps): ToolDefinition<z.ZodObject<{}>> {
  return {
    name: "observe_screen",
    version: "v1",
    description:
      "Capture a fresh screenshot and read the visible controls, fields, and rows. Use it first, and again after any action, because earlier observations go stale.",
    input: z.object({}),
    acts: false,
    run: () => observeNow(deps),
  };
}

function clickControlTool(deps: DesktopToolDeps) {
  return {
    name: "click_control",
    version: "v1",
    description:
      "Click the single visible control that best matches a short description, such as a button, link, tab, or icon name. Requires a fresh observation. Refuses when no control or several identical controls match.",
    input: z.object({ control: z.string().trim().min(1).max(200) }),
    acts: true,
    run: async (input: { control: string }): Promise<ToolResult> => {
      if (!isFresh(deps) || deps.state.observation === null) return freshnessRefusal();
      if (remainingMs(deps) < MIN_ACTION_BUDGET_MS) return deadlineRefusal();
      const grounded = await deps.grounding.selectControl({ observation: deps.state.observation, intent: input.control, signal: deps.signal });
      if (grounded.status === "abstained") return groundingRefusal("control", grounded.reason, grounded.detail);
      if (grounded.value.disabled === true) return disabledRefusal(grounded.value.label);
      const target = centerOf(grounded.value);
      return withSubject(sendBatch(deps, [{ kind: "click", ...target, observationId: deps.state.observation.id }], `clicked "${grounded.value.label}"`), `clicked "${grounded.value.label}"`);
    },
  } satisfies ToolDefinition<z.ZodType<{ control: string }>>;
}

function selectRecordTool(deps: DesktopToolDeps) {
  return {
    name: "select_record",
    version: "v1",
    description:
      "Select the table row whose visible text contains this identity (a name or code, matched as whole words). Refuses when no row or more than one row matches, so an ambiguous record is never selected.",
    input: z.object({ identity: z.string().trim().min(1).max(200) }),
    acts: true,
    run: async (input: { identity: string }): Promise<ToolResult> => {
      if (!isFresh(deps) || deps.state.observation === null) return freshnessRefusal();
      if (remainingMs(deps) < MIN_ACTION_BUDGET_MS) return deadlineRefusal();
      const match = deps.grounding.matchUniqueRecord({ observation: deps.state.observation, identity: input.identity });
      if (match.status === "abstained") return groundingRefusal("record", match.reason, match.detail);
      const target = centerOf(match.value);
      return sendBatch(deps, [{ kind: "click", ...target, observationId: deps.state.observation.id }], `selected the row for "${input.identity}"`);
    },
  } satisfies ToolDefinition<z.ZodType<{ identity: string }>>;
}

function replaceFieldTool(deps: DesktopToolDeps) {
  return {
    name: "replace_field",
    version: "v1",
    description:
      "Click the single visible field that best matches a description (its caption or placeholder), select its existing text, and type the replacement. Does not submit or save. Requires a fresh observation.",
    input: z.object({
      field: z.string().trim().min(1).max(200),
      text: z.string().max(1_000),
    }),
    acts: true,
    run: async (input: { field: string; text: string }): Promise<ToolResult> => {
      if (!isFresh(deps) || deps.state.observation === null) return freshnessRefusal();
      if (remainingMs(deps) < MIN_ACTION_BUDGET_MS) return deadlineRefusal();
      const grounded = await deps.grounding.selectField({ observation: deps.state.observation, intent: input.field, signal: deps.signal });
      if (grounded.status === "abstained") return groundingRefusal("field", grounded.reason, grounded.detail);
      if (grounded.value.disabled === true) return disabledRefusal(grounded.value.label);
      const target = centerOf(grounded.value);
      const observationId = deps.state.observation.id;
      return withSubject(
        sendBatch(
          deps,
          [
            { kind: "click", ...target, observationId },
            { kind: "select_all_and_type", text: input.text, observationId },
          ],
          `replaced the text of "${grounded.value.label}"`,
        ),
        `filled in "${grounded.value.label}"`,
      );
    },
  } satisfies ToolDefinition<z.ZodType<{ field: string; text: string }>>;
}

function scrollScreenTool(deps: DesktopToolDeps) {
  return {
    name: "scroll_screen",
    version: "v1",
    description: "Scroll the visible area up or down by a bounded number of wheel steps. Invalidates the current observation; observe again afterwards.",
    input: z.object({
      direction: z.enum(["up", "down"]),
      steps: z.number().int().min(1).max(MAX_SCROLL_STEPS),
    }),
    acts: true,
    run: async (input: { direction: "up" | "down"; steps: number }): Promise<ToolResult> => {
      if (!isFresh(deps) || deps.state.observation === null) return freshnessRefusal();
      if (remainingMs(deps) < MIN_ACTION_BUDGET_MS) return deadlineRefusal();
      const delta = input.direction === "down" ? input.steps : -input.steps;
      return sendBatch(deps, [{ kind: "scroll", delta, observationId: deps.state.observation.id }], `scrolled ${input.direction} ${input.steps}`);
    },
  } satisfies ToolDefinition<z.ZodType<{ direction: "up" | "down"; steps: number }>>;
}

function pressKeyTool(deps: DesktopToolDeps) {
  return {
    name: "press_key",
    version: "v1",
    description: `Press one key or key chord. Allowed: ${SUPPORTED_KEYS.join(", ")}. Requires a fresh observation.`,
    input: z.object({ key: z.enum(SUPPORTED_KEYS) }),
    acts: true,
    run: async (input: { key: (typeof SUPPORTED_KEYS)[number] }): Promise<ToolResult> => {
      if (keysymsForChord(input.key) === null) return { status: "refused", message: `key "${input.key}" is not supported` };
      if (!isFresh(deps) || deps.state.observation === null) return freshnessRefusal();
      if (remainingMs(deps) < MIN_ACTION_BUDGET_MS) return deadlineRefusal();
      return sendBatch(deps, [{ kind: "key", key: input.key, observationId: deps.state.observation.id }], `pressed ${input.key}`);
    },
  } satisfies ToolDefinition<z.ZodType<{ key: (typeof SUPPORTED_KEYS)[number] }>>;
}

function waitForScreenTool(deps: DesktopToolDeps) {
  return {
    name: "wait_for_screen",
    version: "v1",
    description:
      "Wait for the screen to finish changing, then capture a fresh observation. The wait is shortened when the task deadline is close, and refused when there is no time left to read the screen.",
    input: z.object({ ms: z.number().int().min(WAIT_MIN_MS).max(WAIT_MAX_MS) }),
    acts: false,
    run: async (input: { ms: number }): Promise<ToolResult> => {
      const budget = remainingMs(deps) - OBSERVATION_RESERVE_MS;
      if (budget < WAIT_MIN_MS) return deadlineRefusal();
      const ms = Math.min(input.ms, budget);
      await deps.executor.run([{ kind: "wait", ms, observationId: deps.executor.latestObservation?.observationId ?? "" }]);
      const observed = await observeNow(deps);
      return observed.status === "ok" ? { ...observed, message: `waited ${ms} ms; ${observed.message}` } : observed;
    },
  } satisfies ToolDefinition<z.ZodType<{ ms: number }>>;
}

function setPlanTool(deps: DesktopToolDeps) {
  return {
    name: "set_plan",
    version: "v2",
    description:
      "Record the plan: the goal, optional steps, and completion conditions. Each condition must be a fact one screen can show (for a question, a process fact such as 'the filtered list is shown', not a computed total). Call it before acting, and again to revise conditions after verify_result reports them as partial or not supported.",
    input: z.object({
      goal: z.string().trim().min(1).max(300),
      steps: z.array(z.string().trim().min(1).max(200)).max(12).default([]),
      completion_conditions: z.array(z.string().trim().min(1).max(300)).min(1).max(6),
    }),
    acts: false,
    run: async (input: { goal: string; steps: string[]; completion_conditions: string[] }): Promise<ToolResult> => {
      deps.state.setPlan({ goal: input.goal, steps: input.steps, completionConditions: input.completion_conditions });
      return ok(`plan recorded with ${input.completion_conditions.length} completion condition(s)`);
    },
  } satisfies ToolDefinition<z.ZodType<{ goal: string; steps: string[]; completion_conditions: string[] }>>;
}

// Checks every completion condition of the plan against a fresh observation and stores the
// evidence in the run state. Shared by the verify_result tool and by the loop, which verifies on
// its own when the planner stops without having verified.
export async function verifyNow(deps: DesktopToolDeps): Promise<ToolResult> {
  const plan = deps.state.plan;
  if (plan === null) return { status: "refused", message: "no plan is recorded: call set_plan first" };
  if (remainingMs(deps) < MIN_ACTION_BUDGET_MS) return deadlineRefusal();
  const shot = await deps.executor.observe();
  const outcome = await deps.perception.perceive({ taskId: deps.taskId, screenshot: shot, signal: deps.signal });
  if (outcome.status === "abstained") {
    deps.state.observation = null;
    return { status: "failed", message: `verification could not read the screen (${outcome.reason})` };
  }
  deps.state.setObservation(outcome.observation);
  const results: ConditionResult[] = [];
  for (const condition of plan.completionConditions) {
    const scored = await deps.grounding.scoreTransition({ observation: outcome.observation, expectation: condition, signal: deps.signal });
    const level: ConditionLevel = scored.status === "scored" ? (scored.level as ConditionLevel) : "insufficient_evidence";
    results.push({ condition, level });
  }
  deps.state.verification = {
    observationId: outcome.observation.id,
    inputVersion: deps.state.inputVersion,
    planVersion: deps.state.planVersion,
    results,
  };
  const lines = results.map((r) => `- ${r.condition}: ${r.level}`).join("\n");
  return ok(`verification evidence from observation ${outcome.observation.id}:\n${lines}`, { results });
}

function verifyResultTool(deps: DesktopToolDeps) {
  return {
    name: "verify_result",
    version: "v2",
    description:
      "Check each completion condition of the recorded plan against a fresh observation and return the evidence for each one (supported, partial, not_supported, or insufficient_evidence). Does not end the task. The task ends only after every condition is supported and nothing changed since; if a condition is not, act to make it visible, revise the plan, or report a blocker.",
    input: z.object({}),
    acts: false,
    run: () => verifyNow(deps),
  } satisfies ToolDefinition<z.ZodType<Record<string, never>>>;
}

function reportBlockerTool(deps: DesktopToolDeps) {
  return {
    name: "report_blocker",
    version: "v1",
    description:
      "Report that the task cannot be completed safely: the target is ambiguous or missing, the request is impossible, or the screen cannot be read. The task then ends as failed with this reason. Make no further changes after calling it.",
    input: z.object({ reason: z.string().trim().min(1).max(500) }),
    acts: false,
    run: async (input: { reason: string }): Promise<ToolResult> => {
      deps.state.blocker = input.reason;
      return ok("blocker recorded; the task will end as failed");
    },
  } satisfies ToolDefinition<z.ZodType<{ reason: string }>>;
}

// Adds the UI target to a successful result, so the run can be reduced to a reusable procedure.
// The label is the only thing kept: the typed value is never part of the note.
async function withSubject(result: Promise<ToolResult>, subject: string): Promise<ToolResult> {
  const settled = await result;
  return settled.status === "ok" ? { ...settled, subject } : settled;
}

// Sends one batch of inputs. Records the input before sending, so any input invalidates
// earlier observations and verifications even when the batch fails part way.
async function sendBatch(deps: DesktopToolDeps, batch: Parameters<DesktopExecutor["run"]>[0], success: string): Promise<ToolResult> {
  deps.state.recordInput();
  const results = await deps.executor.run(batch);
  return fromBatch(results, success);
}

