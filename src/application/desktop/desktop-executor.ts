import { abortError, DesktopError } from "../../domain/desktop/errors.ts";
import { createScreenshot, type Screenshot } from "../../domain/desktop/screenshot.ts";
import type { Action } from "../../domain/execution/types.ts";
import type { Clock } from "../ports/clock.ts";
import type { ArtifactStore } from "../ports/artifact-store.ts";
import type { DesktopSession } from "../ports/desktop-session.ts";
import type { IdGenerator } from "../ports/id-generator.ts";
import { keysymsForChord, keysymsForText } from "./keysyms.ts";
import type { TaskId } from "../../domain/tasks/task.ts";
import type { TraceRecorder } from "../trace/trace-recorder.ts";

// Timing rules observed on the target desktop: clicks held under 100 ms are ignored,
// and the screen can take up to one second to repaint.
export const CLICK_HOLD_MS = 120;
export const REPAINT_WINDOW_MS = 1_000;
export const KEY_GAP_MS = 20;
export const ARTIFACT_TIMEOUT_MS = 5_000;
// Budget for releasing held inputs after cancellation.
export const RELEASE_BUDGET_MS = 1_000;
const MAX_WAIT_MS = 10_000;
const MAX_SCROLL_STEPS = 20;

const BUTTON_LEFT = 1;
const WHEEL_UP = 8;
const WHEEL_DOWN = 16;

export interface ExecutorTiming {
  readonly clickHoldMs: number;
  readonly repaintMs: number;
  readonly keyGapMs: number;
  // Upper bound on storing one screenshot artifact; a missed artifact is recorded in the trace.
  readonly artifactTimeoutMs?: number;
}

export type ActionStatus = "executed" | "rejected" | "interrupted" | "failed" | "discarded";

export interface ActionResult {
  readonly kind: Action["kind"];
  readonly status: ActionStatus;
  readonly reason?: string;
  readonly observationId?: string;
}

export interface ExecutorOptions {
  readonly session: DesktopSession;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly screen: { readonly width: number; readonly height: number };
  // Lease signal: aborts at the task deadline or on cancellation.
  readonly signal: AbortSignal;
  readonly timing?: ExecutorTiming;
  // Optional tracing. Without it the executor records nothing.
  readonly trace?: {
    readonly taskId: TaskId;
    readonly recorder: TraceRecorder;
    readonly artifacts?: ArtifactStore;
    // Span of the enclosing task event; desktop events are recorded as its children.
    readonly parentSpanId?: string | null;
  };
}

type Held = { readonly kind: "key"; readonly keysym: number } | { readonly kind: "button"; readonly x: number; readonly y: number };

// Executes short action batches on one desktop. Callers must hold the desktop lease.
// Actions refer to the observation they were planned from; an action whose
// observation is no longer the latest is rejected. Input never retries automatically.
export class DesktopExecutor {
  private latest: Screenshot | null = null;
  private pointer: { x: number; y: number };
  private inputSinceCapture = false;
  private readonly held: Held[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private readonly timing: ExecutorTiming;

  constructor(private readonly options: ExecutorOptions) {
    this.pointer = { x: Math.floor(options.screen.width / 2), y: Math.floor(options.screen.height / 2) };
    this.timing = options.timing ?? { clickHoldMs: CLICK_HOLD_MS, repaintMs: REPAINT_WINDOW_MS, keyGapMs: KEY_GAP_MS };
  }

  get latestObservation(): Screenshot | null {
    return this.latest;
  }

  // Captures an observation. Waits for the repaint window first if input happened since the last capture.
  async observe(): Promise<Screenshot> {
    return this.exclusive(async () => {
      if (this.inputSinceCapture) await this.sleep(this.timing.repaintMs);
      return this.capture();
    });
  }

  // Runs a batch in order. The first non-executed action ends the batch; the rest
  // are reported as discarded. Held inputs are released before returning, unless
  // the task deadline has passed.
  async run(batch: readonly Action[]): Promise<ActionResult[]> {
    return this.exclusive(() => this.runBatch(batch));
  }

  // Batches and observations run one at a time, so their inputs never interleave.
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async runBatch(batch: readonly Action[]): Promise<ActionResult[]> {
    const results: ActionResult[] = [];
    let stopped = false;
    for (const action of batch) {
      if (stopped) {
        results.push({ kind: action.kind, status: "discarded" });
        this.emit("action", { action: action.kind, status: "discarded", reason: null, observation_id: null, duration_ms: 0 });
        continue;
      }
      const result = await this.runOne(action);
      results.push(result);
      if (result.status !== "executed") stopped = true;
    }
    await this.releaseHeld();
    return results;
  }

  private async runOne(action: Action): Promise<ActionResult> {
    const started = this.options.clock.now().getTime();
    const result = await this.perform(action);
    this.emit("action", {
      action: result.kind,
      status: result.status,
      reason: result.reason ?? null,
      observation_id: action.kind === "wait" ? null : action.observationId,
      duration_ms: this.options.clock.now().getTime() - started,
    });
    return result;
  }

  private async perform(action: Action): Promise<ActionResult> {
    const { signal } = this.options;
    if (signal.aborted) return { kind: action.kind, status: "interrupted", reason: abortError(signal).message };
    if (action.kind !== "wait" && action.kind !== "screenshot" && this.latest?.observationId !== action.observationId) {
      return { kind: action.kind, status: "rejected", reason: "action refers to a stale or unknown observation" };
    }
    try {
      switch (action.kind) {
        case "click":
          return await this.click(action.x, action.y);
        case "type":
          return await this.typeText(action.text);
        case "select_all_and_type":
          return await this.selectAllAndType(action.text);
        case "key":
          return await this.pressChord(action.key);
        case "scroll":
          return await this.scroll(action.delta);
        case "wait":
          return await this.wait(action.ms);
        case "screenshot":
          return await this.screenshot();
      }
    } catch (error) {
      return this.resultForError(action.kind, error);
    }
  }

  private async click(x: number, y: number): Promise<ActionResult> {
    if (!this.inScreen(x, y)) return { kind: "click", status: "rejected", reason: "click is outside the screen" };
    await this.pressButton(x, y);
    await this.sleep(this.timing.clickHoldMs);
    await this.releaseButton();
    return { kind: "click", status: "executed" };
  }

  private async typeText(text: string): Promise<ActionResult> {
    await this.typeKeysyms(keysymsForText(text));
    return { kind: "type", status: "executed" };
  }

  private async selectAllAndType(text: string): Promise<ActionResult> {
    await this.pressChordKeys([0xffe3, 0x61]); // Control + a
    await this.typeKeysyms(keysymsForText(text));
    return { kind: "select_all_and_type", status: "executed" };
  }

  private async pressChord(chord: string): Promise<ActionResult> {
    const keysyms = keysymsForChord(chord);
    if (keysyms === null) return { kind: "key", status: "rejected", reason: "unrecognized key" };
    await this.pressChordKeys(keysyms);
    return { kind: "key", status: "executed" };
  }

  private async scroll(delta: number): Promise<ActionResult> {
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > MAX_SCROLL_STEPS) {
      return { kind: "scroll", status: "rejected", reason: "scroll must be 1-20 steps" };
    }
    const mask = delta > 0 ? WHEEL_DOWN : WHEEL_UP;
    for (let step = 0; step < Math.abs(delta); step++) {
      await this.send(() => this.options.session.pointer({ signal: this.options.signal, buttons: mask, ...this.pointer }));
      await this.send(() => this.options.session.pointer({ signal: this.options.signal, buttons: 0, ...this.pointer }));
    }
    this.inputSinceCapture = true;
    return { kind: "scroll", status: "executed" };
  }

  private async wait(ms: number): Promise<ActionResult> {
    if (!Number.isInteger(ms) || ms < 0 || ms > MAX_WAIT_MS) {
      return { kind: "wait", status: "rejected", reason: "wait must be 0-10000 ms" };
    }
    await this.sleep(ms);
    return { kind: "wait", status: "executed" };
  }

  // Waits for repaint after input, then captures a new observation.
  private async screenshot(): Promise<ActionResult> {
    if (this.inputSinceCapture) await this.sleep(this.timing.repaintMs);
    const shot = await this.capture();
    return { kind: "screenshot", status: "executed", observationId: shot.observationId };
  }

  private async capture(): Promise<Screenshot> {
    const observationId = this.options.ids.next();
    const shot = await this.options.session.capture({ observationId, signal: this.options.signal });
    this.latest = shot;
    this.inputSinceCapture = false;
    await this.traceObservation(shot);
    return shot;
  }

  private async traceObservation(shot: Screenshot): Promise<void> {
    const trace = this.options.trace;
    if (!trace) return;
    let artifact: { ref: string; sha256: string; bytes: number } | null = null;
    if (trace.artifacts) {
      try {
        artifact = await withTimeout(
          trace.artifacts.storeScreenshot({ taskId: trace.taskId, screenshot: shot }),
          this.timing.artifactTimeoutMs ?? ARTIFACT_TIMEOUT_MS,
        );
      } catch {
        // The observation is still valid without its screenshot file; record that it is missing.
        this.emit("error", { reason: "screenshot artifact not stored", observation_id: shot.observationId });
      }
    }
    this.emit("observation", {
      observation_id: shot.observationId,
      frame_revision: shot.frameRevision,
      width: shot.width,
      height: shot.height,
      artifact_ref: artifact?.ref ?? null,
      artifact_sha256: artifact?.sha256 ?? null,
    });
  }

  private emit(kind: "action" | "observation" | "error", payload: Record<string, unknown>): void {
    const trace = this.options.trace;
    if (!trace) return;
    trace.recorder.record({ taskId: trace.taskId, kind, payload, parentSpanId: trace.parentSpanId ?? null });
  }

  private async pressButton(x: number, y: number): Promise<void> {
    this.pointer = { x, y };
    await this.send(() => this.options.session.pointer({ signal: this.options.signal, buttons: BUTTON_LEFT, x, y }));
    this.held.push({ kind: "button", x, y });
    this.inputSinceCapture = true;
  }

  private async releaseButton(): Promise<void> {
    const at = this.pointer;
    await this.send(() => this.options.session.pointer({ signal: this.options.signal, buttons: 0, ...at }));
    this.removeHeld((held) => held.kind === "button");
  }

  // Presses keys in order, then releases them in reverse order.
  private async pressChordKeys(keysyms: readonly number[]): Promise<void> {
    for (const keysym of keysyms) {
      await this.send(() => this.options.session.key({ signal: this.options.signal, down: true, keysym }));
      this.held.push({ kind: "key", keysym });
    }
    this.inputSinceCapture = true;
    for (const keysym of [...keysyms].reverse()) {
      await this.send(() => this.options.session.key({ signal: this.options.signal, down: false, keysym }));
      this.removeHeld((held) => held.kind === "key" && held.keysym === keysym);
      await this.sleep(this.timing.keyGapMs);
    }
  }

  private async typeKeysyms(keysyms: readonly number[]): Promise<void> {
    for (const keysym of keysyms) {
      await this.pressChordKeys([keysym]);
    }
  }

  // Each input is checked against the lease before it is sent.
  private async send(operation: () => Promise<void>): Promise<void> {
    if (this.options.signal.aborted) throw abortError(this.options.signal);
    await operation();
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    const { signal } = this.options;
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(abortError(signal));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(abortError(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  // Releases anything still held. Skipped after the task deadline, when there is
  // no budget left to send input.
  private async releaseHeld(): Promise<void> {
    if (this.held.length === 0) return;
    const reason = this.options.signal.reason;
    const pastDeadline = reason instanceof DesktopError && reason.kind === "timeout";
    if (pastDeadline) {
      this.held.length = 0;
      return;
    }
    // Releases ignore the lease signal (it may be aborted by cancellation) but get their own short budget.
    const signal = AbortSignal.timeout(RELEASE_BUDGET_MS);
    for (const held of [...this.held].reverse()) {
      try {
        if (held.kind === "key") {
          await this.options.session.key({ signal, down: false, keysym: held.keysym });
        } else {
          await this.options.session.pointer({ signal, buttons: 0, x: held.x, y: held.y });
        }
      } catch {
        // The session is already closed or the budget is spent; nothing more can be released.
        break;
      }
    }
    this.held.length = 0;
  }

  private removeHeld(match: (held: Held) => boolean): void {
    const index = this.held.findIndex(match);
    if (index >= 0) this.held.splice(index, 1);
  }

  private inScreen(x: number, y: number): boolean {
    const { width, height } = this.options.screen;
    return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < width && y < height;
  }

  private resultForError(kind: Action["kind"], error: unknown): ActionResult {
    if (error instanceof DesktopError && (error.kind === "timeout" || error.kind === "cancelled")) {
      return { kind, status: "interrupted", reason: error.message };
    }
    const reason = error instanceof DesktopError ? error.message : "unexpected executor error";
    return { kind, status: "failed", reason };
  }
}

// Rejects if the operation does not settle within `ms`. The underlying work is not cancelled.
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DesktopError("timeout", "artifact store timed out")), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}
