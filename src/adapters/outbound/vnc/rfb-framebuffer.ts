import { DesktopError } from "../../../domain/desktop/errors.ts";

// Full-screen RGBA buffer. The connection sets the server pixel format to 32 bpp
// little-endian true colour, so incoming pixels are B, G, R, padding in memory.
export class RfbFramebuffer {
  readonly width: number;
  readonly height: number;
  private readonly pixels: Uint8Array;

  constructor(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new DesktopError("protocol_error", "server sent an invalid framebuffer size");
    }
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height * 4);
    for (let i = 3; i < this.pixels.length; i += 4) this.pixels[i] = 255;
  }

  // bgrx must hold exactly w*h pixels of 4 bytes each.
  putRaw(x: number, y: number, w: number, h: number, bgrx: Uint8Array): void {
    this.assertRect(x, y, w, h);
    for (let row = 0; row < h; row++) {
      let src = row * w * 4;
      let dst = ((y + row) * this.width + x) * 4;
      for (let col = 0; col < w; col++, src += 4, dst += 4) {
        this.pixels[dst] = bgrx[src + 2]!;
        this.pixels[dst + 1] = bgrx[src + 1]!;
        this.pixels[dst + 2] = bgrx[src]!;
        this.pixels[dst + 3] = 255;
      }
    }
  }

  // Fills a rectangle with one BGRX pixel (4 bytes).
  fill(x: number, y: number, w: number, h: number, bgrx: Uint8Array): void {
    this.assertRect(x, y, w, h);
    const r = bgrx[2]!;
    const g = bgrx[1]!;
    const b = bgrx[0]!;
    for (let row = 0; row < h; row++) {
      let dst = ((y + row) * this.width + x) * 4;
      for (let col = 0; col < w; col++, dst += 4) {
        this.pixels[dst] = r;
        this.pixels[dst + 1] = g;
        this.pixels[dst + 2] = b;
        this.pixels[dst + 3] = 255;
      }
    }
  }

  // Copies a rectangle within the framebuffer. Source and destination may overlap.
  copy(dstX: number, dstY: number, w: number, h: number, srcX: number, srcY: number): void {
    this.assertRect(dstX, dstY, w, h);
    this.assertRect(srcX, srcY, w, h);
    const rowBytes = w * 4;
    const temp = new Uint8Array(rowBytes * h);
    for (let row = 0; row < h; row++) {
      const start = ((srcY + row) * this.width + srcX) * 4;
      temp.set(this.pixels.subarray(start, start + rowBytes), row * rowBytes);
    }
    for (let row = 0; row < h; row++) {
      const start = ((dstY + row) * this.width + dstX) * 4;
      this.pixels.set(temp.subarray(row * rowBytes, (row + 1) * rowBytes), start);
    }
  }

  // Returns a copy of the current RGBA pixels.
  snapshot(): Uint8Array {
    return this.pixels.slice();
  }

  assertRect(x: number, y: number, w: number, h: number): void {
    if (x < 0 || y < 0 || w < 0 || h < 0 || x + w > this.width || y + h > this.height) {
      throw new DesktopError("protocol_error", "server sent a rectangle outside the framebuffer");
    }
  }
}
