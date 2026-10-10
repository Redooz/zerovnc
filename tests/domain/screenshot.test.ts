import { describe, expect, test } from "bun:test";
import { createScreenshot, ScreenshotError } from "../../src/domain/desktop/screenshot.ts";

const NOW = new Date("2026-10-10T12:00:00.000Z");

describe("screenshot", () => {
  test("copies pixels and freezes the record", () => {
    const rgba = new Uint8Array(2 * 1 * 4).fill(7);
    const shot = createScreenshot({ observationId: "o-1", capturedAt: NOW, width: 2, height: 1, frameRevision: 1, rgba });
    rgba[0] = 0;
    expect(shot.rgba[0]).toBe(7);
    expect(Object.isFrozen(shot)).toBe(true);
    expect(shot.capturedAt.toISOString()).toBe(NOW.toISOString());
  });

  test("rejects pixel buffers that do not match the dimensions", () => {
    expect(() =>
      createScreenshot({ observationId: "o", capturedAt: NOW, width: 2, height: 2, frameRevision: 1, rgba: new Uint8Array(4) }),
    ).toThrow(ScreenshotError);
  });

  test("rejects an empty observation id", () => {
    expect(() =>
      createScreenshot({ observationId: " ", capturedAt: NOW, width: 1, height: 1, frameRevision: 1, rgba: new Uint8Array(4) }),
    ).toThrow(ScreenshotError);
  });
});
