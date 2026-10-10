import { describe, expect, test } from "bun:test";
import { DesktopOwnership, DesktopOwnershipError } from "../../src/application/desktop/desktop-ownership.ts";
import { DesktopError } from "../../src/domain/desktop/errors.ts";

const clock = { now: () => new Date() };
const DESKTOP = "wss://desk-a/websockify";
const OTHER = "wss://desk-b/websockify";

function deadline(ms: number): Date {
  return new Date(Date.now() + ms);
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected rejection");
}

describe("desktop ownership", () => {
  test("grants a free desktop immediately", async () => {
    const ownership = new DesktopOwnership(clock);
    const lease = await ownership.acquire({ key: DESKTOP, deadlineAt: deadline(5_000), signal: signal() });
    expect(lease.signal.aborted).toBe(false);
    expect(ownership.heldCount).toBe(1);
    lease.release();
    expect(ownership.heldCount).toBe(0);
  });

  test("queues a second task on the same desktop and grants in arrival order", async () => {
    const ownership = new DesktopOwnership(clock);
    const order: string[] = [];
    const first = await ownership.acquire({ key: DESKTOP, deadlineAt: deadline(5_000), signal: signal() });
    const second = ownership.acquire({ key: DESKTOP, deadlineAt: deadline(5_000), signal: signal() }).then((lease) => {
      order.push("second");
      return lease;
    });
    const third = ownership.acquire({ key: DESKTOP, deadlineAt: deadline(5_000), signal: signal() }).then((lease) => {
      order.push("third");
      return lease;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual([]);

    first.release();
    const secondLease = await second;
    expect(order).toEqual(["second"]);
    secondLease.release();
    (await third).release();
    expect(order).toEqual(["second", "third"]);
    expect(ownership.heldCount).toBe(0);
  });

  test("different desktops do not block each other", async () => {
    const ownership = new DesktopOwnership(clock);
    const a = await ownership.acquire({ key: DESKTOP, deadlineAt: deadline(5_000), signal: signal() });
    const b = await ownership.acquire({ key: OTHER, deadlineAt: deadline(5_000), signal: signal() });
    expect(ownership.heldCount).toBe(2);
    a.release();
    b.release();
  });

  test("a queued task expires at its deadline without receiving the desktop", async () => {
    const ownership = new DesktopOwnership(clock);
    const holder = await ownership.acquire({ key: DESKTOP, deadlineAt: deadline(5_000), signal: signal() });
    const queued = ownership.acquire({ key: DESKTOP, deadlineAt: deadline(30), signal: signal() });
    const error = await rejectionOf(queued);
    expect(error).toBeInstanceOf(DesktopOwnershipError);
    expect((error as DesktopOwnershipError).reason).toBe("expired");
    holder.release();
    expect(ownership.heldCount).toBe(0);
  });

  test("an expired waiter is skipped, and the next live waiter is granted", async () => {
    const ownership = new DesktopOwnership(clock);
    const holder = await ownership.acquire({ key: DESKTOP, deadlineAt: deadline(5_000), signal: signal() });
    const expiring = ownership.acquire({ key: DESKTOP, deadlineAt: deadline(20), signal: signal() });
    const live = ownership.acquire({ key: DESKTOP, deadlineAt: deadline(5_000), signal: signal() });
    await rejectionOf(expiring);
    holder.release();
    const lease = await live;
    expect(lease.signal.aborted).toBe(false);
    lease.release();
  });

  test("cancelling a queued task removes it from the queue", async () => {
    const ownership = new DesktopOwnership(clock);
    const holder = await ownership.acquire({ key: DESKTOP, deadlineAt: deadline(5_000), signal: signal() });
    const controller = new AbortController();
    const cancelled = ownership.acquire({ key: DESKTOP, deadlineAt: deadline(5_000), signal: controller.signal });
    const next = ownership.acquire({ key: DESKTOP, deadlineAt: deadline(5_000), signal: signal() });
    controller.abort();
    expect(((await rejectionOf(cancelled)) as DesktopOwnershipError).reason).toBe("cancelled");
    holder.release();
    const lease = await next;
    expect(lease.signal.aborted).toBe(false);
    lease.release();
  });

  test("a task already past its deadline never acquires the desktop", async () => {
    const ownership = new DesktopOwnership(clock);
    const error = await rejectionOf(
      ownership.acquire({ key: DESKTOP, deadlineAt: new Date(Date.now() - 1), signal: signal() }),
    );
    expect((error as DesktopOwnershipError).reason).toBe("expired");
    expect(ownership.heldCount).toBe(0);
  });

  test("the lease signal aborts at the task deadline with a timeout reason", async () => {
    const ownership = new DesktopOwnership(clock);
    const lease = await ownership.acquire({ key: DESKTOP, deadlineAt: deadline(30), signal: signal() });
    await new Promise((r) => setTimeout(r, 60));
    expect(lease.signal.aborted).toBe(true);
    expect((lease.signal.reason as DesktopError).kind).toBe("timeout");
    lease.release();
  });

  test("the lease signal aborts on service cancellation with a cancelled reason", async () => {
    const ownership = new DesktopOwnership(clock);
    const controller = new AbortController();
    const lease = await ownership.acquire({ key: DESKTOP, deadlineAt: deadline(5_000), signal: controller.signal });
    controller.abort();
    expect(lease.signal.aborted).toBe(true);
    expect((lease.signal.reason as DesktopError).kind).toBe("cancelled");
    lease.release();
  });

  test("release is idempotent and does not free a desktop granted to someone else", async () => {
    const ownership = new DesktopOwnership(clock);
    const first = await ownership.acquire({ key: DESKTOP, deadlineAt: deadline(5_000), signal: signal() });
    const second = ownership.acquire({ key: DESKTOP, deadlineAt: deadline(5_000), signal: signal() });
    first.release();
    const secondLease = await second;
    first.release();
    expect(ownership.heldCount).toBe(1);
    secondLease.release();
    expect(ownership.heldCount).toBe(0);
  });

  test("close rejects queued tasks, cancels held leases, and waits for release", async () => {
    const ownership = new DesktopOwnership(clock);
    const holder = await ownership.acquire({ key: DESKTOP, deadlineAt: deadline(5_000), signal: signal() });
    const queued = ownership.acquire({ key: DESKTOP, deadlineAt: deadline(5_000), signal: signal() });

    const closing = ownership.close(1_000);
    expect(((await rejectionOf(queued)) as DesktopOwnershipError).reason).toBe("closed");
    expect(holder.signal.aborted).toBe(true);
    holder.release();
    expect(await closing).toBe(true);

    const afterClose = await rejectionOf(
      ownership.acquire({ key: OTHER, deadlineAt: deadline(5_000), signal: signal() }),
    );
    expect((afterClose as DesktopOwnershipError).reason).toBe("closed");
  });

  test("close returns false when a holder does not release within the grace period", async () => {
    const ownership = new DesktopOwnership(clock);
    await ownership.acquire({ key: DESKTOP, deadlineAt: deadline(5_000), signal: signal() });
    expect(await ownership.close(20)).toBe(false);
  });
});
