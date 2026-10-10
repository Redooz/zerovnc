import { afterEach, describe, expect, test } from "bun:test";
import { OpenRouterClient } from "../../src/adapters/outbound/openrouter/openrouter-client.ts";
import { OpenRouterPerceptionModel } from "../../src/adapters/outbound/openrouter/perception-adapter.ts";
import { parsePromptFile } from "../../src/adapters/outbound/openrouter/prompt-file.ts";
import { supportsExplicitCacheBreakpoint } from "../../src/bootstrap/models.ts";
import { createScreenshot } from "../../src/domain/desktop/screenshot.ts";

let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => {
  server?.stop(true);
  server = null;
});

function serve(usage: Record<string, unknown>, sink: { body: any }): string {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      sink.body = await req.json();
      return Response.json({ model: "m", choices: [{ finish_reason: "stop", message: { content: '{"elements":[],"relations":[]}' } }], usage });
    },
  });
  return `http://localhost:${server.port}/api/v1`;
}

const shot = createScreenshot({ observationId: "o", capturedAt: new Date(0), width: 2, height: 2, frameRevision: 1, rgba: new Uint8Array(16) });
const request = { observationId: "obs-xyz", screenshot: shot, signal: new AbortController().signal, timeoutMs: 5000 };
const prompt = parsePromptFile("<!-- prompt-version: perception.vT -->\nStable instructions.");

describe("provider prompt caching", () => {
  test("with a breakpoint, the stable instructions are marked and the changing parts come after", async () => {
    const sink = { body: null as any };
    const base = serve({ prompt_tokens: 2243, completion_tokens: 10 }, sink);
    await new OpenRouterPerceptionModel(new OpenRouterClient("k", base), "anthropic/claude-haiku-5.5", prompt, true).call(request);
    const [system, user] = sink.body.messages;
    expect(system.content).toEqual([{ type: "text", text: "Stable instructions.", cache_control: { type: "ephemeral" } }]);
    // The breakpoint is on the system prefix; the observation id and the image follow it.
    expect(JSON.stringify(user.content)).toContain("obs-xyz");
    expect(JSON.stringify(system)).not.toContain("obs-xyz");
    expect(user.content.some((part: any) => part.type === "image_url")).toBe(true);
  });

  test("without a breakpoint, the system prompt is a plain string and no cache_control is sent", async () => {
    const sink = { body: null as any };
    const base = serve({ prompt_tokens: 1300, completion_tokens: 10 }, sink);
    await new OpenRouterPerceptionModel(new OpenRouterClient("k", base), "deepseek/deepseek-v4.1-flash", prompt, false).call(request);
    expect(sink.body.messages[0].content).toBe("Stable instructions.");
    expect(JSON.stringify(sink.body)).not.toContain("cache_control");
  });

  test("cache read and write tokens reported by the provider reach the call metadata", async () => {
    const sink = { body: null as any };
    const base = serve({ prompt_tokens: 2244, completion_tokens: 10, cost: 0.0005, prompt_tokens_details: { cached_tokens: 864, cache_write_tokens: 0 } }, sink);
    const out = await new OpenRouterPerceptionModel(new OpenRouterClient("k", base), "anthropic/claude-haiku-5.5", prompt, true).call(request);
    expect(out.metadata).toMatchObject({ cacheReadTokens: 864, cacheWriteTokens: 0, costUsd: 0.0005 });
  });

  test("a route that reports no cache usage yields null, not zero", async () => {
    const sink = { body: null as any };
    const base = serve({ prompt_tokens: 1300, completion_tokens: 10 }, sink);
    const out = await new OpenRouterPerceptionModel(new OpenRouterClient("k", base), "deepseek/deepseek-v4.1-flash", prompt, false).call(request);
    expect(out.metadata.cacheReadTokens).toBeNull();
    expect(out.metadata.cacheWriteTokens).toBeNull();
  });

  test("explicit breakpoints are limited to routes verified live (Anthropic)", () => {
    expect(supportsExplicitCacheBreakpoint("anthropic/claude-haiku-5.5")).toBe(true);
    expect(supportsExplicitCacheBreakpoint("deepseek/deepseek-v4.1-flash")).toBe(false);
    expect(supportsExplicitCacheBreakpoint("jev-latest")).toBe(false);
    expect(supportsExplicitCacheBreakpoint("openai/gpt-6-luna-decisions")).toBe(false);
  });
});
