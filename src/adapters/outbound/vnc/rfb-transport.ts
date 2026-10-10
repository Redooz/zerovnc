import { abortError, DesktopError } from "../../../domain/desktop/errors.ts";
import type { RfbReader } from "./rfb-reader.ts";

// Binary byte pipe to the desktop. The RFB connection depends only on this shape,
// so tests can substitute an in-memory server.
export interface ByteTransport {
  send(data: Uint8Array): void;
  close(): void;
}

// Opens a websockify WebSocket (binary subprotocol). Incoming bytes go to the
// reader. Resolves once the socket is open; rejects on failure or abort.
export function openWebSocketTransport(url: string, reader: RfbReader, signal: AbortSignal): Promise<ByteTransport> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError(signal));
    let socket: WebSocket;
    try {
      socket = new WebSocket(url, ["binary"]);
    } catch {
      return reject(new DesktopError("connection_failed", "desktop URL could not be opened"));
    }
    socket.binaryType = "arraybuffer";
    let open = false;

    const onAbort = (): void => {
      socket.close();
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    socket.onopen = () => {
      open = true;
      signal.removeEventListener("abort", onAbort);
      resolve({
        send: (data) => socket.send(data),
        close: () => socket.close(1000),
      });
    };
    socket.onerror = () => {
      if (!open) {
        signal.removeEventListener("abort", onAbort);
        reject(new DesktopError("connection_failed", "desktop WebSocket connection failed"));
      }
      reader.close("socket error");
    };
    socket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        reader.push(new Uint8Array(event.data));
      } else {
        reader.close("unexpected text frame");
        socket.close();
      }
    };
    socket.onclose = (event) => {
      if (!open) {
        signal.removeEventListener("abort", onAbort);
        reject(new DesktopError("connection_failed", `desktop WebSocket closed before opening (${event.code})`));
      }
      reader.close(`socket closed (${event.code})`);
    };
  });
}
