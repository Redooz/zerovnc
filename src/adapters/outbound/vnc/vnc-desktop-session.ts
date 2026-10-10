import type { Clock } from "../../../application/ports/clock.ts";
import type { DesktopSession, DesktopSessionFactory } from "../../../application/ports/desktop-session.ts";
import { abortError, DesktopError } from "../../../domain/desktop/errors.ts";
import { createScreenshot, type Screenshot } from "../../../domain/desktop/screenshot.ts";
import type { DesktopAccess } from "../../../domain/tasks/contracts.ts";
import { RfbConnection } from "./rfb-connection.ts";
import { RfbReader } from "./rfb-reader.ts";
import { openWebSocketTransport } from "./rfb-transport.ts";

export class VncDesktopSessionFactory implements DesktopSessionFactory {
  constructor(private readonly clock: Clock) {}

  async connect(desktop: DesktopAccess, signal: AbortSignal): Promise<DesktopSession> {
    const reader = new RfbReader();
    const transport = await openWebSocketTransport(desktop.url, reader, signal);
    try {
      const connection = await RfbConnection.establish({
        transport,
        reader,
        password: desktop.password,
        signal,
      });
      return new VncDesktopSession(connection, this.clock);
    } catch (error) {
      transport.close();
      throw error;
    }
  }
}

export class VncDesktopSession implements DesktopSession {
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly connection: RfbConnection,
    private readonly clock: Clock,
  ) {}

  get screen(): { readonly width: number; readonly height: number } {
    return { width: this.connection.framebuffer.width, height: this.connection.framebuffer.height };
  }

  capture(input: { readonly observationId: string; readonly signal: AbortSignal }): Promise<Screenshot> {
    return this.serialize(async () => {
      if (this.closed) throw new DesktopError("disconnected", "desktop session is closed");
      try {
        await this.connection.refresh(input.signal);
      } catch (error) {
        // A failed refresh may leave the byte stream mid-message, so the session cannot be reused.
        this.closeNow();
        throw error;
      }
      return createScreenshot({
        observationId: input.observationId,
        capturedAt: this.clock.now(),
        width: this.connection.framebuffer.width,
        height: this.connection.framebuffer.height,
        frameRevision: this.connection.frameRevision,
        rgba: this.connection.framebuffer.snapshot(),
      });
    });
  }

  pointer(input: { readonly buttons: number; readonly x: number; readonly y: number; readonly signal: AbortSignal }): Promise<void> {
    return this.sendInput(input.signal, () => this.connection.pointer(input.buttons, input.x, input.y));
  }

  key(input: { readonly down: boolean; readonly keysym: number; readonly signal: AbortSignal }): Promise<void> {
    return this.sendInput(input.signal, () => this.connection.key(input.down, input.keysym));
  }

  async close(): Promise<void> {
    this.closeNow();
  }

  // Input is written in order with captures. An input whose signal has aborted by the
  // time it reaches the wire is dropped, leaving the session open. A send failure closes the session.
  private sendInput(signal: AbortSignal, send: () => void): Promise<void> {
    return this.serialize(async () => {
      if (this.closed) throw new DesktopError("disconnected", "desktop session is closed");
      if (signal.aborted) throw abortError(signal);
      try {
        send();
      } catch (error) {
        this.closeNow();
        throw error;
      }
    });
  }

  // Runs operations one at a time, in arrival order.
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private closeNow(): void {
    if (this.closed) return;
    this.closed = true;
    this.connection.close();
  }
}
