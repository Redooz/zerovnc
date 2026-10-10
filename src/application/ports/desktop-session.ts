import type { DesktopAccess } from "../../domain/tasks/contracts.ts";
import type { Screenshot } from "../../domain/desktop/screenshot.ts";

// Opens a connection to a desktop with per-request credentials. Failures are
// reported as DesktopError (domain/desktop/errors.ts).
export interface DesktopSessionFactory {
  connect(desktop: DesktopAccess, signal: AbortSignal): Promise<DesktopSession>;
}

// One open connection to one desktop. Operations on a session must not overlap;
// the executor serializes them. A failed operation leaves the session closed.
export interface DesktopSession {
  // Full framebuffer size reported by the desktop.
  readonly screen: { readonly width: number; readonly height: number };
  // Returns a screenshot taken after a complete framebuffer refresh.
  capture(input: { readonly observationId: string; readonly signal: AbortSignal }): Promise<Screenshot>;
  // Sends a pointer event (button mask: bit 0 left, 1 middle, 2 right, 3 wheel up, 4 wheel down).
  // Not sent if `signal` has already aborted when the session reaches it.
  pointer(input: { readonly buttons: number; readonly x: number; readonly y: number; readonly signal: AbortSignal }): Promise<void>;
  // Sends a key press or release with an X11 keysym. Same abort rule as pointer().
  key(input: { readonly down: boolean; readonly keysym: number; readonly signal: AbortSignal }): Promise<void>;
  close(): Promise<void>;
}
