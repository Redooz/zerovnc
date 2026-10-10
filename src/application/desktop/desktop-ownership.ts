import { DesktopError } from "../../domain/desktop/errors.ts";
import type { Clock } from "../ports/clock.ts";

export type OwnershipRejection = "expired" | "cancelled" | "closed";

// Raised when a task cannot obtain exclusive use of a desktop. `expired` means the
// task deadline passed while queued; the desktop was never touched.
export class DesktopOwnershipError extends Error {
  constructor(
    readonly reason: OwnershipRejection,
    message: string,
  ) {
    super(message);
    this.name = "DesktopOwnershipError";
  }
}

// Exclusive use of one desktop. `signal` aborts at the task deadline (reason:
// DesktopError "timeout") or on service cancellation (reason: "cancelled").
// The owner must call release() when it has stopped all desktop activity.
export interface DesktopLease {
  readonly signal: AbortSignal;
  release(): void;
}

export interface AcquireInput {
  // Identity of the desktop, e.g. its URL. Same key means same desktop.
  readonly key: string;
  readonly deadlineAt: Date;
  readonly signal: AbortSignal;
}

interface Waiter {
  readonly deadlineAt: Date;
  readonly signal: AbortSignal;
  readonly resolve: (lease: DesktopLease) => void;
  readonly reject: (error: DesktopOwnershipError) => void;
  readonly cleanup: () => void;
}

interface ActiveLease {
  readonly key: string;
  readonly controller: AbortController;
  readonly timer: ReturnType<typeof setTimeout>;
}

// Per-desktop exclusive ownership with FIFO waiting. Different desktops are
// independent. All state changes happen synchronously, so no locks are needed.
export class DesktopOwnership {
  private readonly queues = new Map<string, Waiter[]>();
  private readonly active = new Map<string, ActiveLease>();
  private readonly idleWaiters: Array<() => void> = [];
  private closing = false;

  constructor(private readonly clock: Clock) {}

  acquire(input: AcquireInput): Promise<DesktopLease> {
    if (this.closing) {
      return Promise.reject(new DesktopOwnershipError("closed", "service is shutting down"));
    }
    if (input.signal.aborted) {
      return Promise.reject(new DesktopOwnershipError("cancelled", "task was cancelled before acquiring the desktop"));
    }
    if (this.msUntil(input.deadlineAt) <= 0) {
      return Promise.reject(new DesktopOwnershipError("expired", "task deadline passed before the desktop was free"));
    }
    if (!this.active.has(input.key) && !this.queues.has(input.key)) {
      return Promise.resolve(this.grant(input.key, input.deadlineAt, input.signal));
    }
    return new Promise<DesktopLease>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeWaiter(input.key, waiter);
        waiter.cleanup();
        reject(new DesktopOwnershipError("expired", "task deadline passed while queued for the desktop"));
      }, this.msUntil(input.deadlineAt));
      const onAbort = (): void => {
        this.removeWaiter(input.key, waiter);
        waiter.cleanup();
        reject(new DesktopOwnershipError("cancelled", "task cancelled while queued for the desktop"));
      };
      input.signal.addEventListener("abort", onAbort, { once: true });
      const waiter: Waiter = {
        deadlineAt: input.deadlineAt,
        signal: input.signal,
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          input.signal.removeEventListener("abort", onAbort);
        },
      };
      const queue = this.queues.get(input.key) ?? [];
      queue.push(waiter);
      this.queues.set(input.key, queue);
    });
  }

  // Number of leases currently held.
  get heldCount(): number {
    return this.active.size;
  }

  // Refuses new acquisitions, rejects queued tasks, and cancels held leases.
  // Resolves true once every lease is released, or false after graceMs.
  async close(graceMs: number): Promise<boolean> {
    this.closing = true;
    for (const [key, queue] of this.queues) {
      this.queues.delete(key);
      for (const waiter of queue) {
        waiter.cleanup();
        waiter.reject(new DesktopOwnershipError("closed", "service is shutting down"));
      }
    }
    for (const lease of this.active.values()) {
      lease.controller.abort(new DesktopError("cancelled", "service is shutting down"));
    }
    if (this.active.size === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<boolean>((resolve) => {
      this.idleWaiters.push(() => resolve(true));
    });
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), graceMs);
    });
    const drained = await Promise.race([idle, timeout]);
    clearTimeout(timer);
    return drained;
  }

  private grant(key: string, deadlineAt: Date, signal: AbortSignal): DesktopLease {
    const controller = new AbortController();
    const onCancel = (): void => controller.abort(new DesktopError("cancelled", "task was cancelled"));
    signal.addEventListener("abort", onCancel, { once: true });
    const timer = setTimeout(
      () => controller.abort(new DesktopError("timeout", "task deadline reached")),
      this.msUntil(deadlineAt),
    );
    const lease: ActiveLease = { key, controller, timer };
    this.active.set(key, lease);

    let released = false;
    return {
      signal: controller.signal,
      release: () => {
        if (released) return;
        released = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onCancel);
        if (this.active.get(key) === lease) this.active.delete(key);
        this.grantNext(key);
        if (this.active.size === 0) {
          for (const notify of this.idleWaiters.splice(0)) notify();
        }
      },
    };
  }

  private grantNext(key: string): void {
    if (this.active.has(key)) return;
    const queue = this.queues.get(key);
    if (!queue) return;
    while (queue.length > 0) {
      const next = queue.shift()!;
      next.cleanup();
      if (this.msUntil(next.deadlineAt) <= 0 || next.signal.aborted) {
        next.reject(new DesktopOwnershipError("expired", "task expired while queued for the desktop"));
        continue;
      }
      if (queue.length === 0) this.queues.delete(key);
      next.resolve(this.grant(key, next.deadlineAt, next.signal));
      return;
    }
    this.queues.delete(key);
  }

  private removeWaiter(key: string, waiter: Waiter): void {
    const queue = this.queues.get(key);
    if (!queue) return;
    const index = queue.indexOf(waiter);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) this.queues.delete(key);
  }

  private msUntil(instant: Date): number {
    return Math.max(0, instant.getTime() - this.clock.now().getTime());
  }
}
