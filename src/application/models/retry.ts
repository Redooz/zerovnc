import { ModelCallError } from "../ports/model-call-error.ts";
import type { ModelRoute } from "./route.ts";

export interface RetryPolicy {
  // Total attempts including the first.
  readonly attempts: number;
  readonly backoffMs: number;
  // Injected for tests; abortable by the request signal.
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  // Called before each retry, so every attempt is visible to traces and reports.
  readonly onRetry?: (info: { readonly model: string; readonly attempt: number; readonly reason: string }) => void;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 2, backoffMs: 400 };

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

// Retries a route only on retryable provider failures. Never retries after the
// caller's signal aborts (cancellation or the task deadline), and the backoff sleep
// ends as soon as the signal aborts. Other failures pass through unchanged.
export function withRetry<Req extends { readonly signal: AbortSignal }, Res>(
  route: ModelRoute<Req, Res>,
  policy: RetryPolicy = DEFAULT_RETRY,
): ModelRoute<Req, Res> {
  const sleep = policy.sleep ?? abortableSleep;
  return {
    model: route.model,
    async call(request: Req): Promise<Res> {
      let attempt = 1;
      for (;;) {
        try {
          return await route.call(request);
        } catch (error) {
          const retry =
            error instanceof ModelCallError && error.retryable && attempt < policy.attempts && !request.signal.aborted;
          if (!retry) throw error;
          policy.onRetry?.({ model: route.model, attempt, reason: (error as ModelCallError).message });
          await sleep(policy.backoffMs * attempt, request.signal);
          if (request.signal.aborted) throw new ModelCallError("cancelled", "request cancelled during retry backoff");
          attempt += 1;
        }
      }
    },
  };
}
