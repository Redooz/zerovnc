import { DesktopError } from "../../../domain/desktop/errors.ts";
import type { RfbFramebuffer } from "./rfb-framebuffer.ts";
import type { RfbReader } from "./rfb-reader.ts";

// Hextile (RFB encoding 5). A rectangle is split into 16x16 tiles, left to right
// and top to bottom; edge tiles are smaller. Each tile starts with a sub-encoding
// byte. Background and foreground colours carry over between tiles of the same
// rectangle until a tile specifies new ones.

export const ENCODING_HEXTILE = 5;

const TILE = 16;
const RAW = 1;
const BACKGROUND_SPECIFIED = 2;
const FOREGROUND_SPECIFIED = 4;
const ANY_SUBRECTS = 8;
const SUBRECTS_COLOURED = 16;

type Pixel = Uint8Array; // 4 bytes, BGRX as sent on the wire

// Decodes one Hextile-encoded rectangle into the framebuffer. Bounds are checked
// before reading the tile's payload, and sub-rectangles must lie inside their tile.
export async function decodeHextile(
  reader: RfbReader,
  framebuffer: RfbFramebuffer,
  rect: { x: number; y: number; w: number; h: number },
  signal: AbortSignal,
): Promise<void> {
  let background: Pixel | null = null;
  let foreground: Pixel | null = null;

  for (let ty = rect.y; ty < rect.y + rect.h; ty += TILE) {
    const tileH = Math.min(TILE, rect.y + rect.h - ty);
    for (let tx = rect.x; tx < rect.x + rect.w; tx += TILE) {
      const tileW = Math.min(TILE, rect.x + rect.w - tx);
      const flags = (await reader.take(1, signal))[0]!;

      if (flags & RAW) {
        const pixels = await reader.take(tileW * tileH * 4, signal);
        framebuffer.putRaw(tx, ty, tileW, tileH, pixels);
        continue;
      }
      if (flags & BACKGROUND_SPECIFIED) background = await reader.take(4, signal);
      if (flags & FOREGROUND_SPECIFIED) foreground = await reader.take(4, signal);
      if (background === null) {
        throw new DesktopError("protocol_error", "hextile tile has no background colour");
      }
      framebuffer.fill(tx, ty, tileW, tileH, background);

      if (flags & ANY_SUBRECTS) {
        const count = (await reader.take(1, signal))[0]!;
        const coloured = (flags & SUBRECTS_COLOURED) !== 0;
        for (let i = 0; i < count; i++) {
          const colour: Pixel | null = coloured ? await reader.take(4, signal) : foreground;
          if (colour === null) {
            throw new DesktopError("protocol_error", "hextile subrectangle has no colour");
          }
          const [sx, sy] = nibbles(await reader.take(1, signal));
          const [sw, sh] = nibbles(await reader.take(1, signal), 1);
          if (sx + sw > tileW || sy + sh > tileH) {
            throw new DesktopError("protocol_error", "hextile subrectangle is outside its tile");
          }
          framebuffer.fill(tx + sx, ty + sy, sw, sh, colour);
        }
      }
    }
  }
}

// Splits a byte into high and low nibbles. With `plusOne`, each value is incremented.
function nibbles(byte: Uint8Array, plusOne = 0): [number, number] {
  const b = byte[0]!;
  return [((b >> 4) & 0x0f) + plusOne, (b & 0x0f) + plusOne];
}
