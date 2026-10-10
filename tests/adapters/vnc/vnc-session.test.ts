import { describe, expect, test } from "bun:test";
import type { RfbConnection } from "../../../src/adapters/outbound/vnc/rfb-connection.ts";
import { VncDesktopSession } from "../../../src/adapters/outbound/vnc/vnc-desktop-session.ts";
import { DesktopError } from "../../../src/domain/desktop/errors.ts";

// Only the input methods are exercised here, so the connection is a recording stub.
function stubConnection(): { connection: RfbConnection; sent: string[] } {
  const sent: string[] = [];
  const connection = {
    framebuffer: { width: 4, height: 3 },
    pointer: (buttons: number, x: number, y: number) => sent.push(`pointer ${buttons} ${x} ${y}`),
    key: (down: boolean, keysym: number) => sent.push(`key ${down} ${keysym}`),
    refresh: async () => undefined,
    close: () => undefined,
    frameRevision: 0,
  };
  return { connection: connection as unknown as RfbConnection, sent };
}

describe("VNC desktop session input", () => {
  test("sends input whose signal is still live", async () => {
    const { connection, sent } = stubConnection();
    const session = new VncDesktopSession(connection, { now: () => new Date() });
    await session.pointer({ buttons: 1, x: 2, y: 1, signal: new AbortController().signal });
    await session.key({ down: true, keysym: 0xff0d, signal: new AbortController().signal });
    expect(sent).toEqual(["pointer 1 2 1", "key true 65293"]);
  });

  test("drops input whose signal has aborted, without closing the session", async () => {
    const { connection, sent } = stubConnection();
    const session = new VncDesktopSession(connection, { now: () => new Date() });
    const controller = new AbortController();
    controller.abort(new DesktopError("timeout", "deadline"));
    let error: unknown = null;
    try {
      await session.pointer({ buttons: 1, x: 0, y: 0, signal: controller.signal });
    } catch (caught) {
      error = caught;
    }
    expect((error as DesktopError).kind).toBe("timeout");
    expect(sent).toEqual([]);
    await session.key({ down: true, keysym: 97, signal: new AbortController().signal });
    expect(sent).toEqual(["key true 97"]);
  });
});
