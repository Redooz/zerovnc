import { describe, expect, test } from "bun:test";
import { settledWithin } from "../../src/bootstrap/bounded.ts";

describe("settledWithin", () => {
  test("reports true when the work settles in time, even if it rejects", async () => {
    expect(await settledWithin(Promise.resolve(1), 100)).toBe(true);
    expect(await settledWithin(Promise.reject(new Error("boom")), 100)).toBe(true);
  });

  test("reports false, promptly, when the work never settles", async () => {
    const started = performance.now();
    expect(await settledWithin(new Promise(() => {}), 30)).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
