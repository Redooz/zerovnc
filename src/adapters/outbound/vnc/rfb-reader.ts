import { abortError, DesktopError } from "../../../domain/desktop/errors.ts";

// Buffers incoming bytes and hands out exact-length reads. WebSocket messages do
// not line up with RFB messages, so one read may span several chunks.
// Only one read may be pending at a time.
export class RfbReader {
  private chunks: Uint8Array[] = [];
  private available = 0;
  private closedReason: string | null = null;
  private wake: (() => void) | null = null;
  private total = 0;

  // Bytes pushed so far, whether or not they have been consumed.
  get receivedBytes(): number {
    return this.total;
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.total += chunk.length;
    this.chunks.push(chunk);
    this.available += chunk.length;
    this.notify();
  }

  // Marks the byte stream as ended. Reads that cannot be satisfied then fail.
  close(reason: string): void {
    this.closedReason ??= reason;
    this.notify();
  }

  async take(n: number, signal: AbortSignal): Promise<Uint8Array> {
    // Checked even when bytes are already buffered, so cancelled work stops reading.
    if (signal.aborted) throw abortError(signal);
    while (this.available < n) {
      if (signal.aborted) throw abortError(signal);
      if (this.closedReason !== null) {
        if (this.available > 0) {
          throw new DesktopError("incomplete_frame", `connection closed mid-message: ${this.closedReason}`);
        }
        throw new DesktopError("disconnected", `connection closed: ${this.closedReason}`);
      }
      await this.waitForData(signal);
    }
    return this.consume(n);
  }

  private waitForData(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.wake = null;
        reject(abortError(signal));
      };
      this.wake = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  private consume(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let offset = 0;
    while (offset < n) {
      const head = this.chunks[0]!;
      const need = n - offset;
      if (head.length <= need) {
        out.set(head, offset);
        offset += head.length;
        this.chunks.shift();
      } else {
        out.set(head.subarray(0, need), offset);
        this.chunks[0] = head.subarray(need);
        offset = n;
      }
    }
    this.available -= n;
    return out;
  }
}
