// Failure taxonomy for model calls. Only some failures may fall back to the
// secondary model; cancellation and the task deadline never do.
//   cancelled - the caller's signal fired (task cancelled or deadline reached)
//   timeout   - this request exceeded its own time limit
//   provider  - transport or provider error (HTTP status, network)
//   malformed - the response could not be parsed or failed validation
export type ModelFailureKind = "cancelled" | "timeout" | "provider" | "malformed";

export class ModelCallError extends Error {
  constructor(
    readonly kind: ModelFailureKind,
    message: string,
    // True for failures that may succeed on a second attempt (5xx, 429, transport errors).
    readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "ModelCallError";
  }
}

export function isFallbackEligible(error: unknown): error is ModelCallError {
  return error instanceof ModelCallError && (error.kind === "timeout" || error.kind === "provider" || error.kind === "malformed");
}
