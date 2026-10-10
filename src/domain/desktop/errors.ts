// Failure categories for desktop access. Messages never contain credentials.
export type DesktopErrorKind =
  | "authentication_failed"
  | "connection_failed"
  | "timeout"
  | "cancelled"
  | "disconnected"
  | "incomplete_frame"
  | "protocol_error";

export class DesktopError extends Error {
  constructor(
    readonly kind: DesktopErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "DesktopError";
  }
}

// Maps an aborted signal to the matching DesktopError. Timeouts come from
// AbortSignal.timeout or a task deadline; anything else is a cancellation.
export function abortError(signal: AbortSignal): DesktopError {
  const reason: unknown = signal.reason;
  if (reason instanceof DesktopError) return reason;
  if (typeof reason === "object" && reason !== null && (reason as { name?: unknown }).name === "TimeoutError") {
    return new DesktopError("timeout", "desktop operation timed out");
  }
  return new DesktopError("cancelled", "desktop operation cancelled");
}
