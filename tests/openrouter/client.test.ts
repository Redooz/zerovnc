import { afterEach, describe, expect, test } from "bun:test";
import { OpenRouterClient } from "../../src/adapters/outbound/openrouter/openrouter-client.ts";
import { ModelCallError } from "../../src/application/ports/model-call-error.ts";

const KEY = "sk-or-test-key-do-not-leak-123";
const CALL = (signal: AbortSignal, timeoutMs = 2000) => ({
  model: "anthropic/claude-haiku-5.5",
  messages: [{ role: "user" as const, content: "hi" }],
  signal,
  timeoutMs,
  maxTokens: 10,
});

let server: ReturnType<typeof Bun.serve> | null = null;
function serve(handler: (req: Request) => Response | Promise<Response>): string {
  server = Bun.serve({ port: 0, fetch: handler });
  return `http://localhost:${server.port}/api/v1`;
}
afterEach(() => {
  server?.stop(true);
  server = null;
});

describe("OpenRouterClient", () => {
  test("parses content, served model, and usage; sends the key only in the header", async () => {
    let seenAuth = "";
    let seenPath = "";
    const base = serve((req) => {
      seenAuth = req.headers.get("authorization") ?? "";
      seenPath = new URL(req.url).pathname;
      return Response.json({
        model: "anthropic/claude-haiku-5.5-20260101",
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0.0004 },
      });
    });
    const reply = await new OpenRouterClient(KEY, base).complete(CALL(new AbortController().signal));
    expect(reply).toMatchObject({ content: '{"ok":true}', servedBy: "anthropic/claude-haiku-5.5-20260101", promptTokens: 12, completionTokens: 3, costUsd: 0.0004 });
    expect(seenAuth).toBe(`Bearer ${KEY}`);
    // The base path (/api/v1) must be kept, not replaced by the endpoint path.
    expect(seenPath).toBe("/api/v1/chat/completions");
  });

  test("an HTTP error is a provider failure and never echoes the key or body", async () => {
    const base = serve(() => new Response(`bad key ${KEY}`, { status: 401 }));
    try {
      await new OpenRouterClient(KEY, base).complete(CALL(new AbortController().signal));
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelCallError);
      expect((error as ModelCallError).kind).toBe("provider");
      expect((error as Error).message).not.toContain(KEY);
      expect((error as Error).message).toContain("401");
    }
  });

  test("a stalled provider is cut off by the per-request limit as a timeout", async () => {
    const base = serve(() => new Promise<Response>(() => {}));
    const started = Date.now();
    try {
      await new OpenRouterClient(KEY, base).complete(CALL(new AbortController().signal, 100));
      throw new Error("expected failure");
    } catch (error) {
      expect((error as ModelCallError).kind).toBe("timeout");
    }
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("the caller's signal cancels the request as cancelled", async () => {
    const base = serve(() => new Promise<Response>(() => {}));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    try {
      await new OpenRouterClient(KEY, base).complete(CALL(controller.signal, 5000));
      throw new Error("expected failure");
    } catch (error) {
      expect((error as ModelCallError).kind).toBe("cancelled");
    }
  });

  test("an already-aborted signal sends nothing", async () => {
    let hits = 0;
    const base = serve(() => {
      hits += 1;
      return Response.json({});
    });
    const controller = new AbortController();
    controller.abort();
    await expect(new OpenRouterClient(KEY, base).complete(CALL(controller.signal))).rejects.toMatchObject({ kind: "cancelled" });
    expect(hits).toBe(0);
  });

  test("a reply without text content is malformed", async () => {
    const base = serve(() => Response.json({ choices: [{ message: {} }] }));
    await expect(new OpenRouterClient(KEY, base).complete(CALL(new AbortController().signal))).rejects.toMatchObject({ kind: "malformed" });
  });

  test("a non-JSON body is a provider failure", async () => {
    const base = serve(() => new Response("<html>gateway</html>", { status: 200 }));
    await expect(new OpenRouterClient(KEY, base).complete(CALL(new AbortController().signal))).rejects.toMatchObject({ kind: "provider" });
  });
});

describe("retryable classification", () => {
  test("5xx and 429 are retryable; other 4xx are not; transport errors are", async () => {
    const statuses = [500, 502, 429, 400, 401];
    const seen: Array<[number, boolean]> = [];
    for (const status of statuses) {
      const base = serve(() => new Response("x", { status }));
      try {
        await new OpenRouterClient(KEY, base).complete(CALL(new AbortController().signal));
      } catch (error) {
        seen.push([status, (error as ModelCallError).retryable]);
      }
      server?.stop(true);
      server = null;
    }
    expect(seen).toEqual([[500, true], [502, true], [429, true], [400, false], [401, false]]);

    const down = new OpenRouterClient(KEY, "http://localhost:1/api/v1");
    await expect(down.complete(CALL(new AbortController().signal))).rejects.toMatchObject({ kind: "provider", retryable: true });
  });
});
