import { describe, expect, test } from "bun:test";
import { InProcessTaskScheduler } from "../../src/adapters/inbound/worker/in-process-task-scheduler.ts";
import { settledWithin } from "../../src/bootstrap/bounded.ts";
import { DesktopOwnership, DesktopOwnershipError } from "../../src/application/desktop/desktop-ownership.ts";

const logger = { info() {}, error() {}, warn() {}, debug() {} } as never;
const clock = { now: () => new Date() };
const later = () => new Date(Date.now() + 60_000);

describe("shutdown", () => {
  test("a task that respects cancellation stops within the grace period", async () => {
    const scheduler = new InProcessTaskScheduler({
      logger,
      run: (_job, signal) => new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve())),
    });
    scheduler.schedule({ taskId: "t1", desktop: { url: "wss://x", password: "p" } } as never);
    expect(await settledWithin(scheduler.stop(), 500)).toBe(true);
    expect(scheduler.runningCount).toBe(0);
  });

  test("a task that ignores cancellation does not hold shutdown past the grace period", async () => {
    const scheduler = new InProcessTaskScheduler({ logger, run: () => new Promise<void>(() => {}) });
    scheduler.schedule({ taskId: "stuck", desktop: { url: "wss://x", password: "p" } } as never);
    const started = performance.now();
    expect(await settledWithin(scheduler.stop(), 50)).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("ownership close rejects the queued task and cancels the holder", async () => {
    const ownership = new DesktopOwnership(clock);
    const held = await ownership.acquire({ key: "d", deadlineAt: later(), signal: new AbortController().signal });
    const queued = ownership.acquire({ key: "d", deadlineAt: later(), signal: new AbortController().signal });
    const drained = ownership.close(500);
    expect((await queued.catch((e) => e)).reason).toBe("closed" satisfies DesktopOwnershipError["reason"]);
    expect(held.signal.aborted).toBe(true);
    held.release();
    expect(await drained).toBe(true);
  });
});
