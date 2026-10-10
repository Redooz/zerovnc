import { abortError, DesktopError } from "../../../domain/desktop/errors.ts";
import { vncAuthResponse } from "./rfb-des.ts";
import { decodeHextile, ENCODING_HEXTILE } from "./rfb-hextile.ts";
import { RfbFramebuffer } from "./rfb-framebuffer.ts";
import type { RfbReader } from "./rfb-reader.ts";
import type { ByteTransport } from "./rfb-transport.ts";

// RFB 3.8 client. Supports VNC and None security. Encodings: Hextile, CopyRect, Raw.
// Refreshes are full-screen requests, so each capture reflects the whole screen.

const ENCODING_RAW = 0;
const ENCODING_COPYRECT = 1;
// Advertised by default. Raw is the default because the practice desktop's Hextile
// updates lagged input by 1.0-4.6 s (Raw: 0.26-0.89 s), which breaks the 1 s repaint
// rule. Hextile stays available through the `encodings` option for measurement.
export const DEFAULT_ENCODINGS: readonly number[] = [ENCODING_RAW, ENCODING_COPYRECT];
const SECURITY_NONE = 1;
const SECURITY_VNC = 2;
const CLIENT_SET_PIXEL_FORMAT = 0;
const CLIENT_SET_ENCODINGS = 2;
const CLIENT_UPDATE_REQUEST = 3;
const CLIENT_KEY_EVENT = 4;
const CLIENT_POINTER_EVENT = 5;
const SERVER_FRAMEBUFFER_UPDATE = 0;
const SERVER_SET_COLOUR_MAP = 1;
const SERVER_BELL = 2;
const SERVER_CUT_TEXT = 3;
const MAX_REASON_BYTES = 4096;

// 32 bpp, depth 24, little-endian true colour, 8-bit channels: pixels are B, G, R, pad.
const PIXEL_FORMAT = Uint8Array.of(32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface EstablishOptions {
  readonly transport: ByteTransport;
  readonly reader: RfbReader;
  readonly password: string;
  readonly signal: AbortSignal;
  // Encodings to advertise, in preference order. Defaults to DEFAULT_ENCODINGS.
  readonly encodings?: readonly number[];
}

export class RfbConnection {
  private revision = 0;
  private closed = false;

  private constructor(
    private readonly transport: ByteTransport,
    private readonly reader: RfbReader,
    readonly framebuffer: RfbFramebuffer,
  ) {}

  // Total bytes received from the desktop since connecting (for measurement).
  get bytesReceived(): number {
    return this.reader.receivedBytes;
  }

  // Number of FramebufferUpdate messages applied so far.
  get frameRevision(): number {
    return this.revision;
  }

  static async establish(options: EstablishOptions): Promise<RfbConnection> {
    const { transport, reader, password, signal } = options;
    const encodings = options.encodings ?? DEFAULT_ENCODINGS;

    const version = decoder.decode(await reader.take(12, signal));
    if (!version.startsWith("RFB ")) {
      throw new DesktopError("protocol_error", "server did not send an RFB version");
    }
    transport.send(encoder.encode("RFB 003.008\n"));

    const securityCount = (await reader.take(1, signal))[0]!;
    if (securityCount === 0) {
      throw new DesktopError("authentication_failed", await readReason(reader, signal));
    }
    const types = await reader.take(securityCount, signal);
    if (types.includes(SECURITY_VNC)) {
      transport.send(Uint8Array.of(SECURITY_VNC));
      const challenge = await reader.take(16, signal);
      transport.send(vncAuthResponse(password, challenge));
    } else if (types.includes(SECURITY_NONE)) {
      transport.send(Uint8Array.of(SECURITY_NONE));
    } else {
      throw new DesktopError("authentication_failed", "desktop offers no supported security type");
    }

    const result = view(await reader.take(4, signal)).getUint32(0);
    if (result !== 0) {
      throw new DesktopError("authentication_failed", await readReason(reader, signal));
    }

    transport.send(Uint8Array.of(1)); // ClientInit: shared
    const init = await reader.take(24, signal);
    const initView = view(init);
    const framebuffer = new RfbFramebuffer(initView.getUint16(0), initView.getUint16(2));
    const nameLength = initView.getUint32(20);
    if (nameLength > MAX_REASON_BYTES) {
      throw new DesktopError("protocol_error", "desktop name is too long");
    }
    await reader.take(nameLength, signal);

    transport.send(setPixelFormatMessage());
    transport.send(setEncodingsMessage(encodings));
    return new RfbConnection(transport, reader, framebuffer);
  }

  // Requests the full screen and waits until every pixel has been written by this
  // refresh's replies. Overlapping rectangles count once; partial coverage keeps waiting.
  async refresh(signal: AbortSignal): Promise<void> {
    this.assertOpen();
    if (signal.aborted) throw abortError(signal);
    const { width, height } = this.framebuffer;
    const coverage = new FrameCoverage(width, height);
    this.transport.send(updateRequestMessage(false, 0, 0, width, height));
    while (!coverage.complete) {
      if (signal.aborted) throw abortError(signal);
      await this.readServerMessage(signal, coverage);
    }
  }

  // Sends a PointerEvent. `buttons` is the RFB button mask (bit 0 left, 1 middle, 2 right, 3 up, 4 down).
  pointer(buttons: number, x: number, y: number): void {
    this.assertOpen();
    const { width, height } = this.framebuffer;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) {
      throw new DesktopError("protocol_error", "pointer position is outside the screen");
    }
    if (!Number.isInteger(buttons) || buttons < 0 || buttons > 255) {
      throw new DesktopError("protocol_error", "invalid pointer button mask");
    }
    this.transport.send(pointerEventMessage(buttons, x, y));
  }

  // Sends a KeyEvent with an X11 keysym.
  key(down: boolean, keysym: number): void {
    this.assertOpen();
    if (!Number.isInteger(keysym) || keysym < 0 || keysym > 0xffffffff) {
      throw new DesktopError("protocol_error", "invalid keysym");
    }
    this.transport.send(keyEventMessage(down, keysym));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.transport.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new DesktopError("disconnected", "desktop connection already closed");
  }

  // Reads one server message, recording any pixels it writes in `coverage`.
  private async readServerMessage(signal: AbortSignal, coverage: FrameCoverage): Promise<void> {
    const type = (await this.reader.take(1, signal))[0]!;
    switch (type) {
      case SERVER_FRAMEBUFFER_UPDATE:
        return this.readFramebufferUpdate(signal, coverage);
      case SERVER_SET_COLOUR_MAP: {
        const header = view(await this.reader.take(5, signal));
        await this.reader.take(6 * header.getUint16(3), signal);
        return;
      }
      case SERVER_BELL:
        return;
      case SERVER_CUT_TEXT: {
        const length = view(await this.reader.take(7, signal)).getUint32(3);
        if (length > MAX_REASON_BYTES * 64) {
          throw new DesktopError("protocol_error", "clipboard message is too long");
        }
        await this.reader.take(length, signal);
        return;
      }
      default:
        throw new DesktopError("protocol_error", `unknown server message type ${type}`);
    }
  }

  private async readFramebufferUpdate(signal: AbortSignal, coverage: FrameCoverage): Promise<void> {
    const header = view(await this.reader.take(3, signal));
    const count = header.getUint16(1);
    for (let i = 0; i < count; i++) {
      const rect = view(await this.reader.take(12, signal));
      const x = rect.getUint16(0);
      const y = rect.getUint16(2);
      const w = rect.getUint16(4);
      const h = rect.getUint16(6);
      const encoding = rect.getInt32(8);
      // Bounds are checked before any payload is read, so a bad rectangle cannot consume the stream.
      if (encoding === ENCODING_HEXTILE) {
        this.framebuffer.assertRect(x, y, w, h);
        await decodeHextile(this.reader, this.framebuffer, { x, y, w, h }, signal);
      } else if (encoding === ENCODING_RAW) {
        this.framebuffer.assertRect(x, y, w, h);
        const data = await this.reader.take(w * h * 4, signal);
        this.framebuffer.putRaw(x, y, w, h, data);
      } else if (encoding === ENCODING_COPYRECT) {
        this.framebuffer.assertRect(x, y, w, h);
        const source = view(await this.reader.take(4, signal));
        this.framebuffer.assertRect(source.getUint16(0), source.getUint16(2), w, h);
        this.framebuffer.copy(x, y, w, h, source.getUint16(0), source.getUint16(2));
      } else {
        throw new DesktopError("protocol_error", `unsupported encoding ${encoding}`);
      }
      coverage.mark(x, y, w, h);
    }
    this.revision++;
  }
}

// Tracks which pixels a refresh has written, so overlapping rectangles count once.
class FrameCoverage {
  private readonly seen: Uint8Array;
  private written = 0;

  constructor(
    private readonly width: number,
    private readonly height: number,
  ) {
    this.seen = new Uint8Array(width * height);
  }

  get complete(): boolean {
    return this.written === this.width * this.height;
  }

  mark(x: number, y: number, w: number, h: number): void {
    for (let row = y; row < y + h; row++) {
      for (let col = x; col < x + w; col++) {
        const index = row * this.width + col;
        if (this.seen[index] === 0) {
          this.seen[index] = 1;
          this.written++;
        }
      }
    }
  }
}

async function readReason(reader: RfbReader, signal: AbortSignal): Promise<string> {
  const length = view(await reader.take(4, signal)).getUint32(0);
  if (length > MAX_REASON_BYTES) return "server rejected the connection";
  return decoder.decode(await reader.take(length, signal)) || "server rejected the connection";
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function setPixelFormatMessage(): Uint8Array {
  const message = new Uint8Array(20);
  message[0] = CLIENT_SET_PIXEL_FORMAT;
  message.set(PIXEL_FORMAT, 4);
  return message;
}

function setEncodingsMessage(encodings: readonly number[]): Uint8Array {
  const message = new Uint8Array(4 + 4 * encodings.length);
  const v = view(message);
  message[0] = CLIENT_SET_ENCODINGS;
  v.setUint16(2, encodings.length);
  encodings.forEach((encoding, index) => v.setInt32(4 + 4 * index, encoding));
  return message;
}

function pointerEventMessage(buttons: number, x: number, y: number): Uint8Array {
  const message = new Uint8Array(6);
  const v = view(message);
  message[0] = CLIENT_POINTER_EVENT;
  message[1] = buttons;
  v.setUint16(2, x);
  v.setUint16(4, y);
  return message;
}

function keyEventMessage(down: boolean, keysym: number): Uint8Array {
  const message = new Uint8Array(8);
  const v = view(message);
  message[0] = CLIENT_KEY_EVENT;
  message[1] = down ? 1 : 0;
  v.setUint32(4, keysym);
  return message;
}

function updateRequestMessage(incremental: boolean, x: number, y: number, w: number, h: number): Uint8Array {
  const message = new Uint8Array(10);
  const v = view(message);
  message[0] = CLIENT_UPDATE_REQUEST;
  message[1] = incremental ? 1 : 0;
  v.setUint16(2, x);
  v.setUint16(4, y);
  v.setUint16(6, w);
  v.setUint16(8, h);
  return message;
}
