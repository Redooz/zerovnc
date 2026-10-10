import { describe, expect, test } from "bun:test";
import { RfbReader } from "../../../src/adapters/outbound/vnc/rfb-reader.ts";
import { DesktopError } from "../../../src/domain/desktop/errors.ts";

describe("RFB reader", () => {
  test("assembles exact reads from fragmented chunks", async () => {
    const reader = new RfbReader();
    const pending = reader.take(4, AbortSignal.timeout(1000));
    for (const byte of [1, 2, 3, 4]) reader.push(Uint8Array.of(byte));
    expect(await pending).toEqual(Uint8Array.of(1, 2, 3, 4));
  });

  test("does not read buffered bytes once the signal is aborted", async () => {
    const reader = new RfbReader();
    reader.push(Uint8Array.of(1, 2, 3, 4));
    const controller = new AbortController();
    controller.abort(new DesktopError("cancelled", "stop"));
    let error: unknown = null;
    try {
      await reader.take(2, controller.signal);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DesktopError);
    expect((error as DesktopError).kind).toBe("cancelled");
  });

  test("reports a stream that ends mid-read as incomplete_frame", async () => {
    const reader = new RfbReader();
    reader.push(Uint8Array.of(1));
    reader.close("socket dropped");
    let error: unknown = null;
    try {
      await reader.take(2, AbortSignal.timeout(1000));
    } catch (caught) {
      error = caught;
    }
    expect((error as DesktopError).kind).toBe("incomplete_frame");
  });
});
