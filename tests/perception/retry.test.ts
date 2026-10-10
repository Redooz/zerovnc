import { describe, expect, test } from "bun:test";
import { withRetry } from "../../src/application/models/retry.ts";
import type { ModelRoute } from "../../src/application/models/route.ts";
import { ModelCallError } from "../../src/application/ports/model-call-error.ts";

type Req = { readonly signal: AbortSignal };

function flaky(failures: Array<ModelCallError | null>): ModelRoute<Req, string> & { calls: number } {
  const route = {
    model: "m",
    calls: 0,
    async call(): Promise<string> {
      const next = failures[route.calls++];
      if (next) throw next;
      return "ok";
    },
  };
  return route;
}
const noSleep = async () => {};

describe("withRetry", () => {
  test("retries a retryable provider failure once and then succeeds", async () => {
    const route = flaky([new ModelCallError("provider", "HTTP 502", true), null]);
    const retries: number[] = [];
    const wrapped = withRetry(route, { attempts: 2, backoffMs: 1, sleep: noSleep, onRetry: (i) => retries.push(i.attempt) });
    expect(await wrapped.call({ signal: new AbortController().signal })).toBe("ok");
    expect(route.calls).toBe(2);
    expect(retries).toEqual([1]);
  });

  test("gives up after the attempt limit and throws the last error", async () => {
    const route = flaky([new ModelCallError("provider", "HTTP 502", true), new ModelCallError("provider", "HTTP 503", true), null]);
    const wrapped = withRetry(route, { attempts: 2, backoffMs: 1, sleep: noSleep });
    await expect(wrapped.call({ signal: new AbortController().signal })).rejects.toThrow("503");
    expect(route.calls).toBe(2);
  });

  test("does not retry non-retryable failures (client errors, malformed replies, timeouts)", async () => {
    for (const error of [new ModelCallError("provider", "HTTP 400", false), new ModelCallError("malformed", "bad"), new ModelCallError("timeout", "slow")]) {
      const route = flaky([error, null]);
      await expect(withRetry(route, { attempts: 3, backoffMs: 1, sleep: noSleep }).call({ signal: new AbortController().signal })).rejects.toBe(error);
      expect(route.calls).toBe(1);
    }
  });

  test("does not retry once the caller's signal has aborted (deadline or cancellation)", async () => {
    const controller = new AbortController();
    const route = flaky([new ModelCallError("provider", "HTTP 502", true), null]);
    route.call = async () => {
      route.calls++;
      controller.abort();
      throw new ModelCallError("provider", "HTTP 502", true);
    };
    await expect(withRetry(route, { attempts: 3, backoffMs: 1, sleep: noSleep }).call({ signal: controller.signal })).rejects.toThrow("502");
    expect(route.calls).toBe(1);
  });

  test("an abort during the backoff sleep stops the retry", async () => {
    const controller = new AbortController();
    const route = flaky([new ModelCallError("provider", "HTTP 502", true), null]);
    const wrapped = withRetry(route, {
      attempts: 3,
      backoffMs: 1,
      sleep: async () => controller.abort(),
    });
    await expect(wrapped.call({ signal: controller.signal })).rejects.toMatchObject({ kind: "cancelled" });
    expect(route.calls).toBe(1);
  });
});
