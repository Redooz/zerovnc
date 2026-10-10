// Immutable snapshot of the desktop screen at one moment. Pixels are RGBA,
// row-major, copied on creation so later framebuffer updates cannot change it.
export interface Screenshot {
  readonly observationId: string;
  readonly capturedAt: Date;
  readonly width: number;
  readonly height: number;
  // Number of framebuffer updates applied before this snapshot was taken.
  readonly frameRevision: number;
  readonly rgba: Uint8Array;
}

export interface ScreenshotInput {
  readonly observationId: string;
  readonly capturedAt: Date;
  readonly width: number;
  readonly height: number;
  readonly frameRevision: number;
  readonly rgba: Uint8Array;
}

export class ScreenshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScreenshotError";
  }
}

export function createScreenshot(input: ScreenshotInput): Screenshot {
  if (input.observationId.trim() === "") throw new ScreenshotError("observation id is required");
  if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width <= 0 || input.height <= 0) {
    throw new ScreenshotError("screenshot dimensions must be positive integers");
  }
  if (!Number.isInteger(input.frameRevision) || input.frameRevision < 0) {
    throw new ScreenshotError("frame revision must be a non-negative integer");
  }
  if (input.rgba.length !== input.width * input.height * 4) {
    throw new ScreenshotError("pixel buffer does not match screenshot dimensions");
  }
  return Object.freeze({
    observationId: input.observationId,
    capturedAt: new Date(input.capturedAt.getTime()),
    width: input.width,
    height: input.height,
    frameRevision: input.frameRevision,
    rgba: input.rgba.slice(),
  });
}
