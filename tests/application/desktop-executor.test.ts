import { describe, expect, test } from "bun:test";
import {
  DesktopExecutor,
  type ActionResult,
  type ExecutorOptions,
} from "../../src/application/desktop/desktop-executor.ts";
import type { DesktopSession } from "../../src/application/ports/desktop-session.ts";
import { DesktopError } from "../../src/domain/desktop/errors.ts";
import { createScreenshot, type Screenshot } from "../../src/domain/desktop/screenshot.ts";
import type { Action } from "../../src/domain/execution/types.ts";

const W = 40;
const H = 30;
const FAST = { clickHoldMs: 0, repaintMs: 0, keyGapMs: 0 };

type Event =
  | { kind: "pointer"; buttons: number; x: number; y: number }
  | { kind: "key"; down: boolean; keysym: number }
  | { kind: "capture"; observationId: string };

// Records every input in order. `failAt` makes the Nth input (1-based) throw.
class RecordingSession implements DesktopSession {
  readonly screen = { width: W, height: H };
  readonly events: Event[] = [];
  private inputs = 0;
  failAt: number | null = null;
  closed = false;

  private input(event: Event): void {
    this.inputs++;
    if (this.failAt === this.inputs) {
      throw new DesktopError("disconnected", "simulated failure");
    }
    this.events.push(event);
  }

  async capture(input: { observationId: string; signal: AbortSignal }): Promise<Screenshot> {
    this.events.push({ kind: "capture", observationId: input.observationId });
    return createScreenshot({
      observationId: input.observationId,
      capturedAt: new Date(),
      width: W,
      height: H,
      frameRevision: this.events.filter((e) => e.kind === "capture").length,
      rgba: new Uint8Array(W * H * 4),
    });
  }

  async pointer(input: { buttons: number; x: number; y: number; signal: AbortSignal }): Promise<void> {
    const { buttons, x, y } = input;
    this.input({ kind: "pointer", buttons, x, y });
  }

  async key(input: { down: boolean; keysym: number; signal: AbortSignal }): Promise<void> {
    const { down, keysym } = input;
    this.input({ kind: "key", down, keysym });
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function setup(options: { signal?: AbortSignal; timing?: ExecutorOptions["timing"] } = {}) {
  const session = new RecordingSession();
  let n = 0;
  const executor = new DesktopExecutor({
    session,
    clock: { now: () => new Date() },
    ids: { next: () => `obs-${++n}` },
    screen: { width: W, height: H },
    signal: options.signal ?? new AbortController().signal,
    timing: "timing" in options ? options.timing : FAST,
  });
  return { session, executor };
}

async function observed(executor: DesktopExecutor): Promise<string> {
  return (await executor.observe()).observationId;
}

describe("desktop executor", () => {
  test("click presses and releases at the target position", async () => {
    const { session, executor } = setup();
    const id = await observed(executor);
    const results = await executor.run([{ kind: "click", x: 5, y: 6, observationId: id }]);
    expect(results.map((r) => r.status)).toEqual(["executed"]);
    expect(session.events.slice(1)).toEqual([
      { kind: "pointer", buttons: 1, x: 5, y: 6 },
      { kind: "pointer", buttons: 0, x: 5, y: 6 },
    ]);
  });

  test("default click holds the button for at least 100 ms", async () => {
    const { executor } = setup({ timing: undefined });
    const id = await observed(executor);
    const started = performance.now();
    await executor.run([{ kind: "click", x: 1, y: 1, observationId: id }]);
    expect(performance.now() - started).toBeGreaterThanOrEqual(100);
  });

  test("rejects clicks outside the screen without sending input", async () => {
    const { session, executor } = setup();
    const id = await observed(executor);
    const [result] = await executor.run([{ kind: "click", x: W, y: 0, observationId: id }]);
    expect(result!.status).toBe("rejected");
    expect(session.events.filter((e) => e.kind === "pointer")).toEqual([]);
  });

  test("rejects an action that refers to a stale observation", async () => {
    const { session, executor } = setup();
    const first = await observed(executor);
    await executor.run([{ kind: "screenshot", observationId: first }]);
    const [result] = await executor.run([{ kind: "click", x: 1, y: 1, observationId: first }]);
    expect(result!.status).toBe("rejected");
    expect(session.events.some((e) => e.kind === "pointer")).toBe(false);
  });

  test("replacement types select-all then the new text, one keysym pair per character", async () => {
    const { session, executor } = setup();
    const id = await observed(executor);
    await executor.run([{ kind: "select_all_and_type", text: "ñá", observationId: id }]);
    expect(session.events.slice(1)).toEqual([
      { kind: "key", down: true, keysym: 0xffe3 },
      { kind: "key", down: true, keysym: 0x61 },
      { kind: "key", down: false, keysym: 0x61 },
      { kind: "key", down: false, keysym: 0xffe3 },
      { kind: "key", down: true, keysym: 0xf1 },
      { kind: "key", down: false, keysym: 0xf1 },
      { kind: "key", down: true, keysym: 0xe1 },
      { kind: "key", down: false, keysym: 0xe1 },
    ]);
  });

  test("a chord presses modifiers first and releases in reverse", async () => {
    const { session, executor } = setup();
    const id = await observed(executor);
    await executor.run([{ kind: "key", key: "shift+Tab", observationId: id }]);
    expect(session.events.slice(1)).toEqual([
      { kind: "key", down: true, keysym: 0xffe1 },
      { kind: "key", down: true, keysym: 0xff09 },
      { kind: "key", down: false, keysym: 0xff09 },
      { kind: "key", down: false, keysym: 0xffe1 },
    ]);
  });

  test("an unrecognized key name is rejected", async () => {
    const { executor } = setup();
    const id = await observed(executor);
    const [result] = await executor.run([{ kind: "key", key: "Hyper+Qwerty", observationId: id }]);
    expect(result!.status).toBe("rejected");
  });

  test("a failed input stops the batch, discards the rest, and releases held keys", async () => {
    const { session, executor } = setup();
    const id = await observed(executor);
    session.failAt = 2; // Control down succeeds, 'a' down fails.
    const results: ActionResult[] = await executor.run([
      { kind: "select_all_and_type", text: "x", observationId: id },
      { kind: "click", x: 1, y: 1, observationId: id },
    ]);
    expect(results.map((r) => r.status)).toEqual(["failed", "discarded"]);
    const released = session.events.at(-1);
    expect(released).toEqual({ kind: "key", down: false, keysym: 0xffe3 });
    expect(session.events.some((e) => e.kind === "pointer")).toBe(false);
  });

  test("a deadline stops input and does not release held inputs", async () => {
    const controller = new AbortController();
    const { session, executor } = setup({ signal: controller.signal });
    const id = await observed(executor);
    const batch = executor.run([{ kind: "click", x: 3, y: 3, observationId: id }]);
    controller.abort(new DesktopError("timeout", "task deadline reached"));
    const [result] = await batch;
    expect(result!.status).toBe("interrupted");
    expect(session.events.filter((e) => e.kind === "pointer" && e.buttons === 0)).toEqual([]);
  });

  test("cancellation during a click still releases the held button", async () => {
    const controller = new AbortController();
    const { session, executor } = setup({
      signal: controller.signal,
      timing: { clickHoldMs: 1_000, repaintMs: 0, keyGapMs: 0 },
    });
    const id = await observed(executor);
    const batch = executor.run([{ kind: "click", x: 3, y: 3, observationId: id }]);
    await new Promise((r) => setTimeout(r, 10));
    controller.abort(new DesktopError("cancelled", "service shutdown"));
    const [result] = await batch;
    expect(result!.status).toBe("interrupted");
    expect(session.events.at(-1)).toEqual({ kind: "pointer", buttons: 0, x: 3, y: 3 });
  });

  test("no input is sent once the signal has aborted", async () => {
    const controller = new AbortController();
    const { session, executor } = setup({ signal: controller.signal });
    const id = await observed(executor);
    controller.abort(new DesktopError("cancelled", "stop"));
    const [result] = await executor.run([{ kind: "type", text: "abc", observationId: id }]);
    expect(result!.status).toBe("interrupted");
    expect(session.events.filter((e) => e.kind === "key")).toEqual([]);
  });

  test("screenshot after input waits for the repaint window; without input it does not", async () => {
    const timing = { clickHoldMs: 0, repaintMs: 80, keyGapMs: 0 };
    const { executor } = setup({ timing });
    const id = await observed(executor);

    let started = performance.now();
    const [idle] = await executor.run([{ kind: "screenshot", observationId: id }]);
    expect(performance.now() - started).toBeLessThan(40);

    const after = idle!.observationId!;
    await executor.run([{ kind: "click", x: 1, y: 1, observationId: after }]);
    started = performance.now();
    const [shot] = await executor.run([{ kind: "screenshot", observationId: after }]);
    expect(shot!.status).toBe("executed");
    expect(performance.now() - started).toBeGreaterThanOrEqual(75);
  });

  test("scroll sends wheel steps at the last pointer position", async () => {
    const { session, executor } = setup();
    const id = await observed(executor);
    await executor.run([{ kind: "scroll", delta: 2, observationId: id }]);
    expect(session.events.slice(1)).toEqual([
      { kind: "pointer", buttons: 16, x: 20, y: 15 },
      { kind: "pointer", buttons: 0, x: 20, y: 15 },
      { kind: "pointer", buttons: 16, x: 20, y: 15 },
      { kind: "pointer", buttons: 0, x: 20, y: 15 },
    ]);
  });

  test("wait is bounded and cancellable", async () => {
    const { executor } = setup();
    const id = await observed(executor);
    const [tooLong] = await executor.run([{ kind: "wait", ms: 20_000, observationId: id }]);
    expect(tooLong!.status).toBe("rejected");

    const controller = new AbortController();
    const { executor: cancellable } = setup({ signal: controller.signal });
    const cid = await observed(cancellable);
    const batch = cancellable.run([{ kind: "wait", ms: 5_000, observationId: cid }]);
    controller.abort(new DesktopError("cancelled", "stop"));
    expect((await batch)[0]!.status).toBe("interrupted");
  });

  test("actions are sent in batch order", async () => {
    const { session, executor } = setup();
    const id = await observed(executor);
    const batch: Action[] = [
      { kind: "click", x: 2, y: 2, observationId: id },
      { kind: "type", text: "a", observationId: id },
    ];
    const results = await executor.run(batch);
    expect(results.map((r) => r.status)).toEqual(["executed", "executed"]);
    const kinds = session.events.map((e) => e.kind);
    expect(kinds).toEqual(["capture", "pointer", "pointer", "key", "key"]);
  });

  test("observe after input waits for the repaint window", async () => {
    const timing = { clickHoldMs: 0, repaintMs: 80, keyGapMs: 0 };
    const { executor } = setup({ timing });
    const id = await observed(executor);
    await executor.run([{ kind: "click", x: 1, y: 1, observationId: id }]);
    const started = performance.now();
    await executor.observe();
    expect(performance.now() - started).toBeGreaterThanOrEqual(75);
  });

  test("concurrent batches run one at a time, so inputs do not interleave", async () => {
    const { session, executor } = setup({ timing: { clickHoldMs: 40, repaintMs: 0, keyGapMs: 0 } });
    const id = await observed(executor);
    const first = executor.run([{ kind: "click", x: 1, y: 1, observationId: id }]);
    const second = executor.run([{ kind: "key", key: "Return", observationId: id }]);
    await Promise.all([first, second]);
    expect(session.events.slice(1).map((e) => e.kind)).toEqual(["pointer", "pointer", "key", "key"]);
    expect(session.events[1]).toMatchObject({ kind: "pointer", buttons: 1 });
    expect(session.events[2]).toMatchObject({ kind: "pointer", buttons: 0 });
  });

  test("cancellation during a held click still releases the button", async () => {
    const controller = new AbortController();
    const { session, executor } = setup({ signal: controller.signal, timing: { clickHoldMs: 2_000, repaintMs: 0, keyGapMs: 0 } });
    const id = await observed(executor);
    const batch = executor.run([{ kind: "click", x: 3, y: 3, observationId: id }]);
    setTimeout(() => controller.abort(new DesktopError("cancelled", "stop")), 30);
    const [result] = await batch;
    expect(result!.status).toBe("interrupted");
    const pointers = session.events.filter((e) => e.kind === "pointer");
    expect(pointers.at(-1)).toMatchObject({ buttons: 0, x: 3, y: 3 });
  });
});
