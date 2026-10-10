import { DesktopError } from "../../domain/desktop/errors.ts";
import type { TraceEventKind } from "../../domain/execution/types.ts";
import type { DesktopAccess } from "../../domain/tasks/contracts.ts";
import { finishTask, isTerminal, type Task, type TaskId } from "../../domain/tasks/task.ts";
import { DesktopExecutor } from "../desktop/desktop-executor.ts";
import { DesktopOwnership, DesktopOwnershipError, type DesktopLease } from "../desktop/desktop-ownership.ts";
import type { ArtifactStore } from "../ports/artifact-store.ts";
import type { Clock } from "../ports/clock.ts";
import type { DesktopSession, DesktopSessionFactory } from "../ports/desktop-session.ts";
import type { IdGenerator } from "../ports/id-generator.ts";
import type { TaskRepository } from "../ports/task-repository.ts";
import { TraceRecorder } from "../trace/trace-recorder.ts";

export const NOT_IMPLEMENTED_SUMMARY = "Ejecución no implementada todavía: solo se observó el escritorio (fase 2).";
export const CANCELLED_SUMMARY = "Tarea interrumpida: el servicio se está cerrando.";
export const INTERNAL_ERROR_SUMMARY = "Error interno durante la ejecución; la tarea no se completó.";
export const EXPIRED_QUEUE_SUMMARY =
  "La tarea venció esperando el escritorio; no se envió ninguna acción al escritorio.";
export const DEADLINE_SUMMARY = "La tarea alcanzó su límite de tiempo; se detuvo la interacción con el escritorio.";

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
}

// Runs one task. Current behaviour (Phase 2): acquires the desktop lease, connects,
// captures an observation, releases the desktop, then ends the task as `fallida`
// because the agent loop arrives in Phase 4. Ordering guarantee: the desktop is
// released and the session closed before the terminal status is stored.
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
      this.trace(task.id, "task_finished", { status: "fallida", summary: outcome });
      await this.deps.repository.save(finishTask(task, "fallida", outcome, this.deps.clock.now()));
    } catch (error) {
      await this.failAfterError(input.taskId);
      throw error;
    } finally {
      this.deps.trace.forgetSecrets(input.taskId);
      this.taskSpans.delete(input.taskId);
    }
  }

  private async runOnDesktop(task: Task, input: ExecuteTaskInput): Promise<string> {
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
          return EXPIRED_QUEUE_SUMMARY;
        }
        this.trace(task.id, "cancelled", { while: "queued" });
        return CANCELLED_SUMMARY;
      }
      throw error;
    }

    this.trace(task.id, "desktop_acquired", { waited_ms: this.deps.clock.now().getTime() - requestedAt });
    let session: DesktopSession | null = null;
    try {
      session = await this.deps.sessions.connect(input.desktop, lease.signal);
      this.trace(task.id, "desktop_connected", { screen: session.screen });
      const executor = new DesktopExecutor({
        session,
        clock: this.deps.clock,
        ids: this.deps.ids,
        screen: session.screen,
        signal: lease.signal,
        trace: {
          taskId: task.id,
          recorder: this.deps.trace,
          artifacts: this.deps.artifacts,
          parentSpanId: this.taskSpans.get(task.id) ?? null,
        },
      });
      await executor.observe();
      return this.summaryAfterAbort(task.id, lease.signal) ?? NOT_IMPLEMENTED_SUMMARY;
    } catch (error) {
      const aborted = this.summaryAfterAbort(task.id, lease.signal);
      if (aborted !== null) return aborted;
      if (error instanceof DesktopError) {
        this.trace(task.id, "error", { reason: error.kind });
        return `El escritorio no respondió correctamente (${error.kind}); no se realizaron acciones.`;
      }
      throw error;
    } finally {
      if (session !== null) {
        await session.close().catch(() => undefined);
        this.trace(task.id, "desktop_disconnected", {});
      }
      lease.release();
      this.trace(task.id, "desktop_released", {});
    }
  }

  // Records and returns the summary when the lease was aborted by the deadline or by
  // cancellation; returns null otherwise.
  private summaryAfterAbort(taskId: TaskId, signal: AbortSignal): string | null {
    if (!signal.aborted) return null;
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
