import type { Clock } from "../../../application/ports/clock.ts";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
