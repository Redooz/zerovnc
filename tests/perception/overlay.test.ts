import { describe, expect, test } from "bun:test";
import { drawNumberedBoxes } from "../../src/adapters/outbound/artifacts/overlay.ts";

const W = 40;
const H = 30;
const blank = () => new Uint8Array(W * H * 4).fill(255);
const px = (buf: Uint8Array, x: number, y: number) => [buf[(y * W + x) * 4], buf[(y * W + x) * 4 + 1], buf[(y * W + x) * 4 + 2]];

describe("drawNumberedBoxes", () => {
  test("draws a red border around the box and leaves the input untouched", () => {
    const source = blank();
    const out = drawNumberedBoxes(W, H, source, [{ number: 1, box: { x: 10, y: 10, w: 20, h: 10 } }]);
    // The number tag covers the left edge, so the right and top edges are checked.
    expect(px(out, 29, 15)).toEqual([255, 0, 0]);
    expect(px(out, 20, 10)).toEqual([255, 0, 0]);
    expect(px(out, 20, 19)).toEqual([255, 0, 0]);
    expect(px(source, 29, 15)).toEqual([255, 255, 255]);
  });

  test("the number tag is drawn inside the box's top-left corner", () => {
    const out = drawNumberedBoxes(W, H, blank(), [{ number: 8, box: { x: 2, y: 2, w: 30, h: 20 } }]);
    // Tag background corner, away from the digit strokes, is yellow.
    expect(px(out, 10, 12)).toEqual([255, 255, 0]);
  });

  test("boxes that extend past the screen are clipped, not an error", () => {
    expect(() => drawNumberedBoxes(W, H, blank(), [{ number: 3, box: { x: 35, y: 25, w: 20, h: 20 } }])).not.toThrow();
  });

  test("a buffer of the wrong size is rejected", () => {
    expect(() => drawNumberedBoxes(W, H, new Uint8Array(4), [])).toThrow(/does not match/);
  });
});
