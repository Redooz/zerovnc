import { isFallbackEligible } from "../ports/model-call-error.ts";

// One configured model behind a port. The model identifier comes from configuration.
export interface ModelRoute<Req, Res> {
  readonly model: string;
  call(request: Req): Promise<Res>;
}

export interface RouteOutcome<Res> {
  readonly result: Res;
  // The model that produced the result, and why the primary was skipped (null if it was not).
  readonly servedBy: string;
  readonly fallbackReason: string | null;
}

// Calls the primary route; on an eligible failure, calls the fallback once. A
// cancelled request is never retried, and the fallback is not tried after a
// cancellation, so the caller's deadline is respected.
export async function callWithFallback<Req, Res>(
  primary: ModelRoute<Req, Res>,
  fallback: ModelRoute<Req, Res>,
  request: Req,
  signal: AbortSignal,
): Promise<RouteOutcome<Res>> {
  try {
    const result = await primary.call(request);
    return { result, servedBy: primary.model, fallbackReason: null };
  } catch (error) {
    if (!isFallbackEligible(error) || signal.aborted) throw error;
    const reason = `${primary.model}: ${error.kind}`;
    const result = await fallback.call(request);
    return { result, servedBy: fallback.model, fallbackReason: reason };
  }
}
