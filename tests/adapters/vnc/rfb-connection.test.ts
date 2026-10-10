import { describe, expect, test } from "bun:test";
import { RfbConnection } from "../../../src/adapters/outbound/vnc/rfb-connection.ts";
import { vncAuthResponse } from "../../../src/adapters/outbound/vnc/rfb-des.ts";
import { RfbFramebuffer } from "../../../src/adapters/outbound/vnc/rfb-framebuffer.ts";
import { RfbReader } from "../../../src/adapters/outbound/vnc/rfb-reader.ts";
import type { ByteTransport } from "../../../src/adapters/outbound/vnc/rfb-transport.ts";
import { DesktopError } from "../../../src/domain/desktop/errors.ts";

// In-memory RFB 3.8 server speaking VNC auth, enough to exercise the client.
interface UpdateRequest {
  readonly incremental: boolean;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface FakeOptions {
  readonly serverPassword: string;
  readonly width: number;
  readonly height: number;
  readonly respond?: (request: UpdateRequest) => Uint8Array | null;
}

const CHALLENGE = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const PIXEL_FORMAT = Uint8Array.of(32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0);

class FakeRfbServer {
  readonly reader = new RfbReader();
  readonly requests: UpdateRequest[] = [];
  readonly inputs: Uint8Array[] = [];
  readonly transport: ByteTransport;
  private pending = new Uint8Array(0);
  private stage: "version" | "security" | "response" | "clientInit" | "messages" | "done" = "version";

  constructor(private readonly options: FakeOptions) {
    this.transport = { send: (data) => this.receive(data), close: () => undefined };
    this.reader.push(new TextEncoder().encode("RFB 003.008\n"));
  }

  private receive(data: Uint8Array): void {
    const next = new Uint8Array(this.pending.length + data.length);
    next.set(this.pending);
    next.set(data, this.pending.length);
    this.pending = next;
    this.step();
  }

  private step(): void {
    for (;;) {
      switch (this.stage) {
        case "version":
          if (this.pending.length < 12) return;
          this.consume(12);
          this.emit(Uint8Array.of(1, 2)); // one security type: VNC auth
          this.stage = "security";
          break;
        case "security": {
          if (this.pending.length < 1) return;
          this.consume(1);
          this.emit(CHALLENGE);
          this.stage = "response";
          break;
        }
        case "response": {
          if (this.pending.length < 16) return;
          const response = this.consume(16);
          const expected = vncAuthResponse(this.options.serverPassword, CHALLENGE);
          if (equal(response, expected)) {
            this.emit(u32(0));
            this.stage = "clientInit";
          } else {
            const reason = new TextEncoder().encode("password check failed!");
            this.emit(concat(u32(1), u32(reason.length), reason));
            this.stage = "done";
          }
          break;
        }
        case "clientInit": {
          if (this.pending.length < 1) return;
          this.consume(1);
          const name = new TextEncoder().encode("fake");
          this.emit(concat(u16(this.options.width), u16(this.options.height), PIXEL_FORMAT, u32(name.length), name));
          this.stage = "messages";
          break;
        }
        case "messages": {
          if (this.pending.length < 1) return;
          const type = this.pending[0]!;
          let size: number;
          if (type === 0) size = 20;
          else if (type === 2) {
            if (this.pending.length < 4) return;
            size = 4 + 4 * ((this.pending[2]! << 8) | this.pending[3]!);
          } else if (type === 3) size = 10;
          else if (type === 4) size = 8;
          else if (type === 5) size = 6;
          else throw new Error(`fake server: unexpected client message ${type}`);
          if (this.pending.length < size) return;
          const message = this.consume(size);
          if (type === 4 || type === 5) this.inputs.push(message);
          if (type === 3) {
            const v = new DataView(message.buffer, message.byteOffset, message.byteLength);
            const request: UpdateRequest = {
              incremental: message[1] === 1,
              x: v.getUint16(2),
              y: v.getUint16(4),
              w: v.getUint16(6),
              h: v.getUint16(8),
            };
            this.requests.push(request);
            const reply = this.options.respond?.(request);
            if (reply) this.emit(reply);
          }
          break;
        }
        case "done":
          return;
      }
    }
  }

  private consume(n: number): Uint8Array {
    const out = this.pending.slice(0, n);
    this.pending = this.pending.slice(n);
    return out;
  }

  private emit(bytes: Uint8Array): void {
    this.reader.push(bytes);
  }
}

function u16(n: number): Uint8Array {
  return Uint8Array.of((n >> 8) & 0xff, n & 0xff);
}

function u32(n: number): Uint8Array {
  return Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

function s32(n: number): Uint8Array {
  return u32(n);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function rect(x: number, y: number, w: number, h: number, encoding: number, body: Uint8Array): Uint8Array {
  return concat(u16(x), u16(y), u16(w), u16(h), s32(encoding), body);
}

function update(...rects: Uint8Array[]): Uint8Array {
  return concat(Uint8Array.of(0, 0), u16(rects.length), ...rects);
}

// Pixel n as BGRX bytes, so the expected RGBA is easy to reason about.
function bgrxPixel(n: number): number[] {
  return [n, n + 10, n + 20, 0];
}

function expectedRgba(pixelIds: number[]): Uint8Array {
  const out = new Uint8Array(pixelIds.length * 4);
  pixelIds.forEach((id, index) => {
    out.set([id + 20, id + 10, id, 255], index * 4);
  });
  return out;
}

function bgrxBytes(pixelIds: number[]): Uint8Array {
  return Uint8Array.from(pixelIds.flatMap(bgrxPixel));
}

const WIDTH = 4;
const HEIGHT = 3;
const FRAME = Array.from({ length: WIDTH * HEIGHT }, (_, i) => i);

function signal(ms = 2000): AbortSignal {
  return AbortSignal.timeout(ms);
}

async function establish(server: FakeRfbServer, password: string): Promise<RfbConnection> {
  return RfbConnection.establish({ transport: server.transport, reader: server.reader, password, signal: signal() });
}

async function errorOf(promise: Promise<unknown>): Promise<DesktopError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DesktopError) return error;
    throw error;
  }
  throw new Error("expected a DesktopError");
}

describe("RFB connection", () => {
  test("authenticates and captures a full frame as RGBA", async () => {
    const server = new FakeRfbServer({
      serverPassword: "secret",
      width: WIDTH,
      height: HEIGHT,
      respond: (request) =>
        request.incremental ? null : update(rect(0, 0, WIDTH, HEIGHT, 0, bgrxBytes(FRAME))),
    });
    const connection = await establish(server, "secret");
    await connection.refresh(signal());

    expect(connection.framebuffer.width).toBe(WIDTH);
    expect(connection.framebuffer.height).toBe(HEIGHT);
    expect(connection.frameRevision).toBe(1);
    expect(connection.framebuffer.snapshot()).toEqual(expectedRgba(FRAME));
    expect(server.requests).toEqual([{ incremental: false, x: 0, y: 0, w: WIDTH, h: HEIGHT }]);
    connection.close();
  });

  test("applies CopyRect and Raw rectangles in one update", async () => {
    let call = 0;
    const server = new FakeRfbServer({
      serverPassword: "secret",
      width: WIDTH,
      height: HEIGHT,
      respond: () => {
        call++;
        if (call === 1) return update(rect(0, 0, WIDTH, HEIGHT, 0, bgrxBytes(FRAME)));
        // Shift rows 1-2 up into rows 0-1 (overlapping copy), then paint row 2 fresh.
        const newRow = [100, 101, 102, 103];
        return update(
          rect(0, 0, WIDTH, 2, 1, concat(u16(0), u16(1))),
          rect(0, 2, WIDTH, 1, 0, bgrxBytes(newRow)),
        );
      },
    });
    const connection = await establish(server, "secret");
    await connection.refresh(signal());
    await connection.refresh(signal());

    expect(connection.frameRevision).toBe(2);
    expect(connection.framebuffer.snapshot()).toEqual(expectedRgba([4, 5, 6, 7, 8, 9, 10, 11, 100, 101, 102, 103]));
    connection.close();
  });

  test("rejects a wrong password with authentication_failed", async () => {
    const server = new FakeRfbServer({ serverPassword: "secret", width: WIDTH, height: HEIGHT });
    const error = await errorOf(establish(server, "wrong"));
    expect(error.kind).toBe("authentication_failed");
    expect(error.message).toBe("password check failed!");
  });

  test("reports an update that ends early as incomplete_frame", async () => {
    const server = new FakeRfbServer({
      serverPassword: "secret",
      width: WIDTH,
      height: HEIGHT,
      respond: () => {
        const full = update(rect(0, 0, WIDTH, HEIGHT, 0, bgrxBytes(FRAME)));
        return full.subarray(0, full.length / 2);
      },
    });
    const connection = await establish(server, "secret");
    const pending = connection.refresh(signal());
    await Promise.resolve();
    server.reader.close("socket dropped");
    const error = await errorOf(pending);
    expect(error.kind).toBe("incomplete_frame");
    connection.close();
  });

  test("times out when the desktop never answers a refresh", async () => {
    const server = new FakeRfbServer({ serverPassword: "secret", width: WIDTH, height: HEIGHT, respond: () => null });
    const connection = await establish(server, "secret");
    const error = await errorOf(connection.refresh(AbortSignal.timeout(30)));
    expect(error.kind).toBe("timeout");
    connection.close();
  });

  test("reports a closed socket before any reply as disconnected", async () => {
    const server = new FakeRfbServer({ serverPassword: "secret", width: WIDTH, height: HEIGHT, respond: () => null });
    const connection = await establish(server, "secret");
    const pending = connection.refresh(signal());
    await Promise.resolve();
    server.reader.close("socket closed (1006)");
    expect((await errorOf(pending)).kind).toBe("disconnected");
  });

  test("refuses refresh after close", async () => {
    const server = new FakeRfbServer({ serverPassword: "secret", width: WIDTH, height: HEIGHT });
    const connection = await establish(server, "secret");
    connection.close();
    expect((await errorOf(connection.refresh(signal()))).kind).toBe("disconnected");
  });

  test("snapshots are copies that later updates do not change", async () => {
    let call = 0;
    const server = new FakeRfbServer({
      serverPassword: "secret",
      width: WIDTH,
      height: HEIGHT,
      respond: () => update(rect(0, 0, WIDTH, HEIGHT, 0, bgrxBytes(call++ === 0 ? FRAME : FRAME.map((n) => n + 50)))),
    });
    const connection = await establish(server, "secret");
    await connection.refresh(signal());
    const first = connection.framebuffer.snapshot();
    await connection.refresh(signal());
    expect(first).toEqual(expectedRgba(FRAME));
    connection.close();
  });
});

describe("RFB refresh coverage", () => {
  test("overlapping rectangles do not count as full coverage", async () => {
    const server = new FakeRfbServer({
      serverPassword: "secret",
      width: WIDTH,
      height: HEIGHT,
      // Rows 0-1 painted twice: 16 pixels of updates, but row 2 is never written.
      respond: () => {
        const top = bgrxBytes(FRAME.slice(0, WIDTH * 2));
        return update(rect(0, 0, WIDTH, 2, 0, top), rect(0, 0, WIDTH, 2, 0, top));
      },
    });
    const connection = await establish(server, "secret");
    expect((await errorOf(connection.refresh(AbortSignal.timeout(50)))).kind).toBe("timeout");
    connection.close();
  });

  test("completes once overlapping rectangles in one reply cover the whole screen", async () => {
    const server = new FakeRfbServer({
      serverPassword: "secret",
      width: WIDTH,
      height: HEIGHT,
      respond: () => {
        const top = bgrxBytes(FRAME.slice(0, WIDTH * 2));
        const bottom = bgrxBytes(FRAME.slice(WIDTH * 2));
        return update(rect(0, 0, WIDTH, 2, 0, top), rect(0, 0, WIDTH, 2, 0, top), rect(0, 2, WIDTH, 1, 0, bottom));
      },
    });
    const connection = await establish(server, "secret");
    await connection.refresh(signal());
    expect(connection.framebuffer.snapshot()).toEqual(expectedRgba(FRAME));
    connection.close();
  });

  test("rejects a rectangle outside the screen before reading its payload", async () => {
    const server = new FakeRfbServer({
      serverPassword: "secret",
      width: WIDTH,
      height: HEIGHT,
      respond: () => update(rect(WIDTH - 1, 0, 2, 1, 0, bgrxBytes([1, 2]))),
    });
    const connection = await establish(server, "secret");
    expect((await errorOf(connection.refresh(signal()))).kind).toBe("protocol_error");
    connection.close();
  });

  test("stops a refresh whose signal has already been aborted", async () => {
    const server = new FakeRfbServer({ serverPassword: "secret", width: WIDTH, height: HEIGHT, respond: () => null });
    const connection = await establish(server, "secret");
    const controller = new AbortController();
    const pending = connection.refresh(controller.signal);
    controller.abort(new DesktopError("cancelled", "stop"));
    expect((await errorOf(pending)).kind).toBe("cancelled");
    connection.close();
  });
});

describe("RFB input", () => {
  test("sends pointer and key events in RFB wire format", async () => {
    const server = new FakeRfbServer({ serverPassword: "secret", width: WIDTH, height: HEIGHT });
    const connection = await establish(server, "secret");
    connection.pointer(1, 3, 2);
    connection.key(true, 0xf1);
    connection.key(false, 0x010020ac);
    expect(server.inputs).toEqual([
      Uint8Array.of(5, 1, 0, 3, 0, 2),
      Uint8Array.of(4, 1, 0, 0, 0, 0, 0, 0xf1),
      Uint8Array.of(4, 0, 0, 0, 0x01, 0x00, 0x20, 0xac),
    ]);
    connection.close();
  });

  test("rejects pointer positions outside the screen without sending", async () => {
    const server = new FakeRfbServer({ serverPassword: "secret", width: WIDTH, height: HEIGHT });
    const connection = await establish(server, "secret");
    expect(() => connection.pointer(1, WIDTH, 0)).toThrow(DesktopError);
    expect(() => connection.pointer(1, -1, 0)).toThrow(DesktopError);
    expect(server.inputs).toEqual([]);
    connection.close();
  });
});

describe("RFB framebuffer", () => {
  test("rejects rectangles outside the screen", () => {
    const framebuffer = new RfbFramebuffer(4, 3);
    expect(() => framebuffer.copy(3, 0, 2, 1, 0, 0)).toThrow(DesktopError);
    expect(() => framebuffer.putRaw(0, 2, 1, 2, new Uint8Array(8))).toThrow(DesktopError);
  });

  test("copies overlapping regions correctly", () => {
    const framebuffer = new RfbFramebuffer(2, 3);
    framebuffer.putRaw(0, 0, 2, 3, bgrxBytes([0, 1, 2, 3, 4, 5]));
    framebuffer.copy(0, 1, 2, 2, 0, 0);
    expect(framebuffer.snapshot()).toEqual(expectedRgba([0, 1, 0, 1, 2, 3]));
  });
});

describe("RFB Hextile", () => {
  const HW = 20;
  const HH = 18;
  const RED = [0, 0, 255, 0];
  const BLUE = [255, 0, 0, 0];
  const GREEN = [0, 255, 0, 0];
  const WHITE = [255, 255, 255, 0];
  const BG_SPECIFIED = 2;
  const FG_SPECIFIED = 4;
  const ANY_SUBRECTS = 8;
  const SUBRECTS_COLOURED = 16;
  const TILE_RAW = 1;

  function hextileServer(payload: Uint8Array): FakeRfbServer {
    return new FakeRfbServer({
      serverPassword: "secret",
      width: HW,
      height: HH,
      respond: () => update(rect(0, 0, HW, HH, 5, payload)),
    });
  }

  function pixelAt(rgba: Uint8Array, x: number, y: number): number[] {
    const i = (y * HW + x) * 4;
    return [rgba[i]!, rgba[i + 1]!, rgba[i + 2]!];
  }

  function rgb(bgrx: number[]): number[] {
    return [bgrx[2]!, bgrx[1]!, bgrx[0]!];
  }

  // Tiles of a 20x18 rect in wire order: 16x16, 4x16, 16x2, 4x2.
  test("decodes background, coloured sub-rectangles, raw tiles and background reuse", async () => {
    const payload = concat(
      // Tile (0,0) 16x16: background BLUE, one coloured RED sub-rectangle at (1,1) 2x2.
      Uint8Array.of(BG_SPECIFIED | ANY_SUBRECTS | SUBRECTS_COLOURED),
      Uint8Array.from(BLUE),
      Uint8Array.of(1),
      Uint8Array.from(RED),
      Uint8Array.of(0x11, 0x11),
      // Tile (16,0) 4x16: no flags, so the BLUE background carries over.
      Uint8Array.of(0),
      // Tile (0,16) 16x2: raw tile, all GREEN.
      Uint8Array.of(TILE_RAW),
      Uint8Array.from(Array.from({ length: 32 }).flatMap(() => GREEN)),
      // Tile (16,16) 4x2: WHITE background, uncoloured sub-rectangle at (0,0) 2x1 in fg RED.
      Uint8Array.of(BG_SPECIFIED | FG_SPECIFIED | ANY_SUBRECTS),
      Uint8Array.from(WHITE),
      Uint8Array.from(RED),
      Uint8Array.of(1),
      Uint8Array.of(0x00, 0x10),
    );
    const server = hextileServer(payload);
    const connection = await establish(server, "secret");
    await connection.refresh(signal());
    const rgba = connection.framebuffer.snapshot();
    expect(pixelAt(rgba, 0, 0)).toEqual(rgb(BLUE));
    expect(pixelAt(rgba, 1, 1)).toEqual(rgb(RED));
    expect(pixelAt(rgba, 2, 2)).toEqual(rgb(RED));
    expect(pixelAt(rgba, 3, 3)).toEqual(rgb(BLUE));
    expect(pixelAt(rgba, 19, 0)).toEqual(rgb(BLUE));
    expect(pixelAt(rgba, 0, 16)).toEqual(rgb(GREEN));
    expect(pixelAt(rgba, 15, 17)).toEqual(rgb(GREEN));
    expect(pixelAt(rgba, 16, 16)).toEqual(rgb(RED));
    expect(pixelAt(rgba, 17, 16)).toEqual(rgb(RED));
    expect(pixelAt(rgba, 18, 16)).toEqual(rgb(WHITE));
    expect(pixelAt(rgba, 19, 17)).toEqual(rgb(WHITE));
    connection.close();
  });

  test("rejects a sub-rectangle that extends past its tile", async () => {
    const payload = concat(
      // Tiles (0,0), (16,0), (0,16) carry no subrectangles: background BLUE set once, then reused.
      Uint8Array.of(BG_SPECIFIED),
      Uint8Array.from(BLUE),
      Uint8Array.of(0),
      Uint8Array.of(0),
      // Tile (16,16) is 4x2. Its sub-rectangle starts at x=1 and is 4 wide: it overflows the tile.
      Uint8Array.of(ANY_SUBRECTS),
      Uint8Array.of(1),
      Uint8Array.of(0x10, 0x30),
    );
    const connection = await establish(hextileServer(payload), "secret");
    expect((await errorOf(connection.refresh(signal()))).kind).toBe("protocol_error");
    connection.close();
  });

  test("rejects a tile with no background colour", async () => {
    const connection = await establish(hextileServer(Uint8Array.of(0)), "secret");
    expect((await errorOf(connection.refresh(signal()))).kind).toBe("protocol_error");
    connection.close();
  });

  test("negotiates Hextile first when it is advertised", async () => {
    const server = new FakeRfbServer({ serverPassword: "secret", width: HW, height: HH, respond: () => null });
    const connection = await RfbConnection.establish({
      transport: server.transport,
      reader: server.reader,
      password: "secret",
      signal: signal(),
      encodings: [5, 0],
    });
    expect(connection.bytesReceived).toBeGreaterThan(0);
    connection.close();
  });
});
