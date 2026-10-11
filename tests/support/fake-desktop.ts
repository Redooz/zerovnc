// A fake desktop for tool and loop tests: a real DesktopExecutor over a scripted session that
// logs every input, plus a controllable clock. No network.
import { DesktopExecutor } from "../../src/application/desktop/desktop-executor.ts";
import type { DesktopSession } from "../../src/application/ports/desktop-session.ts";
import type { Clock } from "../../src/application/ports/clock.ts";
import { createScreenshot } from "../../src/domain/desktop/screenshot.ts";

export class FakeClock implements Clock {
  constructor(private ms: number) {}
  now(): Date {
    return new Date(this.ms);
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

export interface FakeDesktop {
  readonly log: string[];
  readonly executor: DesktopExecutor;
  readonly controller: AbortController;
  readonly clock: FakeClock;
}

export function fakeDesktop(options: { deadlineInMs?: number; startMs?: number; screen?: number } = {}): FakeDesktop {
  const log: string[] = [];
  const size = options.screen ?? 8;
  const clock = new FakeClock(options.startMs ?? Date.parse("2026-10-10T12:00:00.000Z"));
  const controller = new AbortController();
  let captures = 0;
  let ids = 0;
  const session: DesktopSession = {
    screen: { width: size, height: size },
    async capture(input) {
      captures += 1;
      log.push("capture");
      return createScreenshot({
        observationId: input.observationId,
        capturedAt: clock.now(),
        width: size,
        height: size,
        frameRevision: captures,
        rgba: new Uint8Array(size * size * 4),
      });
    },
    async pointer(input) {
      log.push(`pointer:${input.buttons}@${input.x},${input.y}`);
    },
    async key(input) {
      log.push(`key:${input.down ? "down" : "up"}:${input.keysym}`);
    },
    async close() {
      log.push("close");
    },
  };
  const executor = new DesktopExecutor({
    session,
    clock,
    ids: { next: () => `obs-${++ids}` },
    screen: { width: size, height: size },
    signal: controller.signal,
    deadlineAt: new Date(clock.now().getTime() + (options.deadlineInMs ?? 300_000)),
    timing: { clickHoldMs: 1, repaintMs: 1, keyGapMs: 0 },
  });
  return { log, executor, controller, clock };
}

// Inputs only (no captures): what reached the desktop.
export function inputsOf(log: readonly string[]): string[] {
  return log.filter((entry) => entry.startsWith("pointer") || entry.startsWith("key"));
}
