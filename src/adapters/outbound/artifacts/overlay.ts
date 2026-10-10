// Draws numbered candidate boxes onto a copy of an RGBA screenshot, so a vision
// model can refer to candidates by number. Uses a built-in 3x5 digit font: no
// image dependency. Pure function over pixels; the input buffer is not modified.
import type { Box } from "../../../domain/perception/observation.ts";

export interface NumberedBox {
  readonly number: number;
  readonly box: Box;
}

const BORDER = [255, 0, 0, 255] as const;
const LABEL_BG = [255, 255, 0, 255] as const;
const LABEL_FG = [0, 0, 0, 255] as const;
const SCALE = 2;

// 3 columns x 5 rows per digit; each row is 3 bits, left bit is the left column.
const DIGITS: Record<string, readonly number[]> = {
  "0": [0b111, 0b101, 0b101, 0b101, 0b111],
  "1": [0b010, 0b110, 0b010, 0b010, 0b111],
  "2": [0b111, 0b001, 0b111, 0b100, 0b111],
  "3": [0b111, 0b001, 0b111, 0b001, 0b111],
  "4": [0b101, 0b101, 0b111, 0b001, 0b001],
  "5": [0b111, 0b100, 0b111, 0b001, 0b111],
  "6": [0b111, 0b100, 0b111, 0b101, 0b111],
  "7": [0b111, 0b001, 0b010, 0b010, 0b010],
  "8": [0b111, 0b101, 0b111, 0b101, 0b111],
  "9": [0b111, 0b101, 0b111, 0b001, 0b111],
};

export function drawNumberedBoxes(width: number, height: number, rgba: Uint8Array, boxes: readonly NumberedBox[]): Uint8Array {
  if (rgba.length !== width * height * 4) throw new Error("RGBA buffer does not match overlay dimensions");
  const out = rgba.slice();

  const put = (x: number, y: number, color: readonly number[]): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    out[i] = color[0]!;
    out[i + 1] = color[1]!;
    out[i + 2] = color[2]!;
    out[i + 3] = color[3]!;
  };

  for (const { number, box } of boxes) {
    // Border, two pixels thick, clipped to the screen.
    for (let t = 0; t < 2; t++) {
      for (let x = box.x; x < box.x + box.w; x++) {
        put(x, box.y + t, BORDER);
        put(x, box.y + box.h - 1 - t, BORDER);
      }
      for (let y = box.y; y < box.y + box.h; y++) {
        put(box.x + t, y, BORDER);
        put(box.x + box.w - 1 - t, y, BORDER);
      }
    }

    // Number tag on the top-left corner, inside the box.
    const text = String(number);
    const tagW = text.length * 4 * SCALE + 2;
    const tagH = 5 * SCALE + 2;
    for (let y = box.y; y < box.y + tagH; y++) {
      for (let x = box.x; x < box.x + tagW; x++) put(x, y, LABEL_BG);
    }
    let cursor = box.x + 1;
    for (const character of text) {
      const glyph = DIGITS[character];
      if (glyph === undefined) throw new Error(`no glyph for ${character}`);
      glyph.forEach((row, ry) => {
        for (let cx = 0; cx < 3; cx++) {
          if ((row >> (2 - cx)) & 1) {
            for (let sy = 0; sy < SCALE; sy++) {
              for (let sx = 0; sx < SCALE; sx++) {
                put(cursor + cx * SCALE + sx, box.y + 1 + ry * SCALE + sy, LABEL_FG);
              }
            }
          }
        }
      });
      cursor += 4 * SCALE;
    }
  }
  return out;
}
