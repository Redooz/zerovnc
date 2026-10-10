import type { TraceEvent, TraceEventKind } from "../../domain/execution/types.ts";
import type { TaskId } from "../../domain/tasks/task.ts";
import type { Clock } from "../ports/clock.ts";
import type { IdGenerator } from "../ports/id-generator.ts";
import type { Logger } from "../ports/logger.ts";
import type { TraceRepository } from "../ports/trace-repository.ts";
import { redactValue } from "./redaction.ts";

export interface RecordInput {
  readonly taskId: TaskId;
  readonly kind: TraceEventKind;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly parentSpanId?: string | null;
}

// Records trace events in order. Recording never throws: a failed write is counted
// and logged, so tracing cannot break the desktop work it describes. Payloads are
// redacted before they leave this object.
export class TraceRecorder {
  private readonly taskSecrets = new Map<TaskId, string[]>();
  private readonly globalSecrets: string[];
  private inflight: Promise<void> = Promise.resolve();
  private droppedCount = 0;

  constructor(
    private readonly deps: {
      readonly repository: TraceRepository;
      readonly clock: Clock;
      readonly ids: IdGenerator;
      readonly logger: Logger;
    },
    globalSecrets: readonly string[] = [],
  ) {
    this.globalSecrets = [...globalSecrets];
  }

  // Registers a secret for one task (for example the desktop password). Forgotten
  // when the task's trace is finished.
  addSecret(taskId: TaskId, secret: string): void {
    const list = this.taskSecrets.get(taskId) ?? [];
    list.push(secret);
    this.taskSecrets.set(taskId, list);
  }

  forgetSecrets(taskId: TaskId): void {
    this.taskSecrets.delete(taskId);
  }

  get droppedEvents(): number {
    return this.droppedCount;
  }

  record(input: RecordInput): string {
    const secrets = [...this.globalSecrets, ...(this.taskSecrets.get(input.taskId) ?? [])];
    const event: TraceEvent = {
      taskId: input.taskId,
      spanId: this.deps.ids.next(),
      parentSpanId: input.parentSpanId ?? null,
      kind: input.kind,
      at: this.deps.clock.now(),
      payload: redactValue(input.payload ?? {}, secrets),
    };
    // Appends run one after another, so the stored order matches the record order.
    this.inflight = this.inflight
      .then(() => this.deps.repository.append([event]))
      .catch((error: unknown) => {
        this.droppedCount++;
        this.deps.logger.error("trace event not stored", {
          task_id: input.taskId,
          kind: input.kind,
          reason: error instanceof Error ? error.name : "unknown",
        });
      });
    return event.spanId;
  }

  // Waits for pending writes, up to timeoutMs. Returns false if writes are still
  // pending; callers must not wait longer, so shutdown is never delayed by tracing.
  async flush(timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const done = this.inflight.then(() => true as const);
    const result = await Promise.race([done, timeout]);
    clearTimeout(timer);
    return result;
  }
}
