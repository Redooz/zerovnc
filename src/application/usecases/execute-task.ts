import { DesktopError } from "../../domain/desktop/errors.ts";
import type { TraceEventKind } from "../../domain/execution/types.ts";
import type { DesktopAccess } from "../../domain/tasks/contracts.ts";
import { finishTask, isTerminal, type Task, type TaskId, type TerminalStatus } from "../../domain/tasks/task.ts";
import { DesktopExecutor } from "../desktop/desktop-executor.ts";
import { DesktopOwnership, DesktopOwnershipError, type DesktopLease } from "../desktop/desktop-ownership.ts";
import { PerceiveScreen, type PerceiveScreenDeps } from "../perception/perceive-screen.ts";
import { PerceptionFrameCache } from "../perception/frame-cache.ts";
import { GroundingService, type GroundingDeps } from "../grounding/grounding-service.ts";
import { runAgentLoop, DEADLINE_SUMMARY } from "../agent/agent-loop.ts";
import { createTaskToolSet, type DesktopToolDeps } from "../tools/desktop-tools.ts";
import { TaskRunState } from "../tools/run-state.ts";
import { appKeyOf } from "../knowledge/knowledge.ts";
import type { KnowledgeNote, KnowledgeRepository } from "../ports/knowledge-repository.ts";
import type { ArtifactStore } from "../ports/artifact-store.ts";
import type { AgentPlanner } from "../ports/agent-planner.ts";
import type { Clock } from "../ports/clock.ts";
import type { DesktopSession, DesktopSessionFactory } from "../ports/desktop-session.ts";
import type { IdGenerator } from "../ports/id-generator.ts";
import type { ModelCallEvent } from "../ports/model-call-observer.ts";
import type { TaskRepository } from "../ports/task-repository.ts";
import { TraceRecorder } from "../trace/trace-recorder.ts";

export const NOT_IMPLEMENTED_SUMMARY = "Ejecución no implementada todavía: solo se observó el escritorio (fase 2).";
export const CANCELLED_SUMMARY = "Tarea interrumpida: el servicio se está cerrando.";
export const INTERNAL_ERROR_SUMMARY = "Error interno durante la ejecución; la tarea no se completó.";
export const EXPIRED_QUEUE_SUMMARY =
  "La tarea venció esperando el escritorio; no se envió ninguna acción al escritorio.";
export { DEADLINE_SUMMARY } from "../agent/agent-loop.ts";

// Notes offered to one task: a safety bound on prompt size.
export const MAX_NOTES_PER_TASK = 5;

// Longest wait for trace writes before a terminal status is published.
export const TRACE_FLUSH_BEFORE_STATUS_MS = 2_000;

// Model routes and planner used by every task. Per-task pieces (frame cache, perception and
// grounding instances, tool set) are built inside ExecuteTask, so nothing is shared between tasks.
export interface AgentRuntime {
  readonly planner: AgentPlanner;
  readonly perception: Omit<PerceiveScreenDeps, "cache" | "observe">;
  readonly perceptionCacheVersion: string;
  readonly grounding: Omit<GroundingDeps, "observe">;
  readonly frameCache: { readonly maxEntries: number; readonly ttlMs: number };
  // Learned procedures. Absent means no learning; `learning` decides whether notes are read and written.
  readonly knowledge?: KnowledgeRepository;
  readonly learning?: boolean;
}

export interface ExecuteTaskInput {
  readonly taskId: TaskId;
  readonly desktop: DesktopAccess;
  readonly signal: AbortSignal;
}

export interface ExecuteTaskDeps {
  readonly repository: TaskRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly ownership: DesktopOwnership;
  readonly sessions: DesktopSessionFactory;
  readonly trace: TraceRecorder;
  readonly artifacts: ArtifactStore;
  readonly agent: AgentRuntime;
}

interface TaskOutcome {
  readonly status: TerminalStatus;
  readonly summary: string;
  // Present when the task was verified and learning is on: a reusable procedure to store.
  readonly note?: { readonly steps: readonly string[]; readonly screenKey: string };
}

// Runs one task: acquires the desktop lease, runs the observe-plan-act-verify loop, releases the
// desktop, then publishes the terminal status. Only this use case sets the status.
// Ordering guarantee: the desktop is released, the session closed, and the frame cache cleared
// before the terminal status is stored.
export class ExecuteTask {
  // Span of each running task's task_started event, used as the parent of desktop events.
  private readonly taskSpans = new Map<TaskId, string>();

  constructor(private readonly deps: ExecuteTaskDeps) {}

  async execute(input: ExecuteTaskInput): Promise<void> {
    try {
      this.trace(input.taskId, "task_received", {});
      const task = await this.deps.repository.findById(input.taskId);
      if (task === null || isTerminal(task.status)) {
        return;
      }
      this.deps.trace.addSecret(task.id, input.desktop.password);
      const taskSpan = this.trace(task.id, "task_started", {});
      this.taskSpans.set(task.id, taskSpan);
      const outcome = await this.runOnDesktop(task, input);
      this.trace(task.id, "task_finished", { status: outcome.status, summary: outcome.summary });
      await this.deps.trace.flush(TRACE_FLUSH_BEFORE_STATUS_MS);
      await this.deps.repository.save(finishTask(task, outcome.status, outcome.summary, this.deps.clock.now()));
      await this.remember(task.id, input.desktop.url, outcome);
    } catch (error) {
      await this.failAfterError(input.taskId);
      throw error;
    } finally {
      this.deps.trace.forgetSecrets(input.taskId);
      this.taskSpans.delete(input.taskId);
    }
  }

  private async runOnDesktop(task: Task, input: ExecuteTaskInput): Promise<TaskOutcome> {
    const requestedAt = this.deps.clock.now().getTime();
    this.trace(task.id, "desktop_queued", {});
    let lease: DesktopLease;
    try {
      lease = await this.deps.ownership.acquire({
        key: input.desktop.url,
        deadlineAt: task.deadlineAt,
        signal: input.signal,
      });
    } catch (error) {
      if (error instanceof DesktopOwnershipError) {
        if (error.reason === "expired") {
          this.trace(task.id, "desktop_expired", {});
          this.trace(task.id, "deadline_reached", { while: "queued" });
          return { status: "fallida", summary: EXPIRED_QUEUE_SUMMARY };
        }
        this.trace(task.id, "cancelled", { while: "queued" });
        return { status: "fallida", summary: CANCELLED_SUMMARY };
      }
      throw error;
    }

    this.trace(task.id, "desktop_acquired", { waited_ms: this.deps.clock.now().getTime() - requestedAt });
    let session: DesktopSession | null = null;
    let frameCache: PerceptionFrameCache | null = null;
    try {
      session = await this.deps.sessions.connect(input.desktop, lease.signal);
      this.trace(task.id, "desktop_connected", { screen: session.screen });
      const executor = new DesktopExecutor({
        session,
        clock: this.deps.clock,
        ids: this.deps.ids,
        screen: session.screen,
        signal: lease.signal,
        deadlineAt: task.deadlineAt,
        trace: {
          taskId: task.id,
          recorder: this.deps.trace,
          artifacts: this.deps.artifacts,
          parentSpanId: this.taskSpans.get(task.id) ?? null,
        },
      });
      // One frame cache per task, cleared when the task ends.
      frameCache = new PerceptionFrameCache({ ...this.deps.agent.frameCache, clock: this.deps.clock });
      const toolDeps = this.toolDeps(task, executor, frameCache, lease.signal);
      const tools = createTaskToolSet(toolDeps, {
        now: () => this.deps.clock.now().getTime(),
        onInvocation: (record) => {
          if (record.subject !== undefined && record.status === "ok") toolDeps.state.noteActed(record.subject);
          this.trace(task.id, "tool_invocation", {
            tool: record.tool,
            invocation_id: record.invocationId,
            tool_version: record.version,
            status: record.status,
            message: record.message,
            reason: record.reason,
            duration_ms: record.durationMs,
          });
        },
      });
      const notes = await this.learnedNotes(task.id, input.desktop.url);

      const outcome = await runAgentLoop({
        instruction: task.instruction,
        planner: this.deps.agent.planner,
        tools,
        toolDeps,
        clock: this.deps.clock,
        signal: lease.signal,
        deadlineAt: task.deadlineAt,
        trace: (kind, payload) => {
          this.trace(task.id, kind as TraceEventKind, payload);
        },
        onModelCall: (event) => this.traceModelCall(task.id, event),
        secrets: [input.desktop.password],
        notes,
      });
      if (outcome.kind === "stopped") {
        return { status: "fallida", summary: this.summaryAfterAbort(task.id, lease.signal) };
      }
      const note =
        outcome.status === "terminada" && toolDeps.state.startScreenKey !== null && toolDeps.state.actedSubjects.length > 0
          ? { steps: [...toolDeps.state.actedSubjects], screenKey: toolDeps.state.startScreenKey }
          : undefined;
      return { status: outcome.status, summary: outcome.summary, note };
    } catch (error) {
      if (lease.signal.aborted) return { status: "fallida", summary: this.summaryAfterAbort(task.id, lease.signal) };
      if (error instanceof DesktopError) {
        this.trace(task.id, "error", { reason: error.kind });
        return {
          status: "fallida",
          summary: `El escritorio no respondió correctamente (${error.kind}); no se realizaron acciones.`,
        };
      }
      throw error;
    } finally {
      frameCache?.clear();
      if (session !== null) {
        await session.close().catch(() => undefined);
        this.trace(task.id, "desktop_disconnected", {});
      }
      lease.release();
      this.trace(task.id, "desktop_released", {});
    }
  }

  // Per-task perception and grounding. Model calls observe the lease signal, so they stop at the
  // task deadline or on cancellation, not only at the component timeouts.
  private toolDeps(task: Task, executor: DesktopExecutor, frameCache: PerceptionFrameCache, signal: AbortSignal): DesktopToolDeps & { state: TaskRunState } {
    const { agent } = this.deps;
    const observe = (event: ModelCallEvent): void => this.traceModelCall(task.id, event);
    const perception = new PerceiveScreen({
      ...agent.perception,
      observe,
      cache: { store: frameCache, version: agent.perceptionCacheVersion },
    });
    const grounding = new GroundingService({ ...agent.grounding, observe });
    const state = new TaskRunState();
    return {
      taskId: task.id,
      executor,
      perception,
      grounding,
      state,
      clock: this.deps.clock,
      deadlineAt: task.deadlineAt,
      signal,
    };
  }

  // Notes a verified procedure for later tasks on the same app. Learning must never fail a task:
  // a read or write error is logged and ignored.
  private async remember(taskId: TaskId, desktopUrl: string, outcome: TaskOutcome): Promise<void> {
    const repository = this.deps.agent.knowledge;
    if (repository === undefined || this.deps.agent.learning !== true || outcome.note === undefined) return;
    try {
      await repository.save({ appKey: appKeyOf(desktopUrl), screenKey: outcome.note.screenKey, steps: outcome.note.steps, taskId });
      this.trace(taskId, "knowledge_saved", { steps: outcome.note.steps.length });
    } catch (error) {
      this.trace(taskId, "knowledge_error", { reason: error instanceof Error ? error.name : "unknown" });
    }
  }

  // Notes for this app, read once per task. Empty when learning is off.
  private async learnedNotes(_taskId: TaskId, desktopUrl: string): Promise<readonly KnowledgeNote[]> {
    const repository = this.deps.agent.knowledge;
    if (repository === undefined || this.deps.agent.learning !== true) return [];
    try {
      return await repository.forApp(appKeyOf(desktopUrl), MAX_NOTES_PER_TASK);
    } catch {
      return [];
    }
  }

  private traceModelCall(taskId: TaskId, event: ModelCallEvent): void {
    this.trace(taskId, "model_call", {
      role: event.role,
      observation_id: event.observationId,
      question_id: event.questionId,
      configured_model: event.configuredModel,
      served_by: event.servedBy,
      prompt_version: event.promptVersion,
      fallback_reason: event.fallbackReason,
      prompt_tokens: event.promptTokens,
      completion_tokens: event.completionTokens,
      cost_usd: event.costUsd,
      latency_ms: event.latencyMs,
      outcome: event.outcome,
      failure: event.failure,
    });
  }

  // Returns the summary when the lease was aborted by the deadline or by cancellation.
  // Called only after the signal aborted, so it always returns a summary.
  private summaryAfterAbort(taskId: TaskId, signal: AbortSignal): string {
    const reason = signal.reason;
    if (reason instanceof DesktopError && reason.kind === "timeout") {
      this.trace(taskId, "deadline_reached", { while: "active" });
      return DEADLINE_SUMMARY;
    }
    this.trace(taskId, "cancelled", { while: "active" });
    return CANCELLED_SUMMARY;
  }

  private trace(taskId: TaskId, kind: TraceEventKind, payload: Record<string, unknown>): string {
    return this.deps.trace.record({ taskId, kind, payload });
  }

  private async failAfterError(taskId: TaskId): Promise<void> {
    try {
      const task = await this.deps.repository.findById(taskId);
      if (task !== null && !isTerminal(task.status)) {
        await this.deps.repository.save(finishTask(task, "fallida", INTERNAL_ERROR_SUMMARY, this.deps.clock.now()));
      }
    } catch {
      // The original error is rethrown by the caller; the startup recovery
      // pass will mark the task fallida if this write also failed.
    }
  }
}
