import { describe, expect, test } from "bun:test";
import { OpenRouterClient } from "../../src/adapters/outbound/openrouter/openrouter-client.ts";
import { ModelCallError } from "../../src/application/ports/model-call-error.ts";

function clientReturning(body: unknown, status = 200) {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const client = new OpenRouterClient("key", "https://openrouter.test/api/v1", async (url, init) => {
    requests.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  return { client, requests };
}

const call = {
  model: "anthropic/claude-haiku-5.5",
  messages: [{ role: "user" as const, content: "hola" }],
  tools: [{ type: "function" as const, function: { name: "observe_screen", description: "d", parameters: { type: "object" } } }],
  signal: new AbortController().signal,
  timeoutMs: 5_000,
  maxTokens: 100,
};

describe("OpenRouter tool-calling chat", () => {
  test("sends tool declarations with auto tool choice and parses tool calls and usage", async () => {
    const { client, requests } = clientReturning({
      model: "anthropic/claude-haiku-5.5",
      choices: [
        {
          finish_reason: "tool_calls",
          message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "observe_screen", arguments: "{}" } }] },
        },
      ],
      usage: { prompt_tokens: 120, completion_tokens: 15, cost: 0.002, prompt_tokens_details: { cached_tokens: 100 } },
    });
    const reply = await client.completeWithTools(call);
    expect(requests[0]!.url).toBe("https://openrouter.test/api/v1/chat/completions");
    expect(requests[0]!.body).toMatchObject({ tool_choice: "auto", tools: call.tools, temperature: 0 });
    expect(reply.toolCalls).toEqual([{ id: "c1", name: "observe_screen", arguments: "{}" }]);
    expect(reply.content).toBeNull();
    expect(reply).toMatchObject({ finishReason: "tool_calls", promptTokens: 120, completionTokens: 15, cacheReadTokens: 100, costUsd: 0.002 });
  });

  test("a text-only reply has no tool calls", async () => {
    const { client } = clientReturning({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Listo." } }] });
    const reply = await client.completeWithTools(call);
    expect(reply.content).toBe("Listo.");
    expect(reply.toolCalls).toEqual([]);
  });

  test("a reply with neither text nor tool calls is malformed", async () => {
    const { client } = clientReturning({ choices: [{ message: { role: "assistant", content: "" } }] });
    await expect(client.completeWithTools(call)).rejects.toMatchObject({ kind: "malformed" });
  });

  test("HTTP 5xx is a retryable provider failure", async () => {
    const { client } = clientReturning({ error: "down" }, 503);
    const error = await client.completeWithTools(call).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelCallError);
    expect(error).toMatchObject({ kind: "provider", retryable: true });
  });
});

describe("provider routing", () => {
  const reply = { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }] };
  function withSort(sort: "throughput" | null) {
    const bodies: Array<Record<string, unknown>> = [];
    const client = new OpenRouterClient("key", "https://openrouter.test/api/v1", async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(reply), { status: 200 });
    }, undefined, sort);
    return { client, bodies };
  }

  test("a configured sort is sent on tool-calling and plain chat requests", async () => {
    const { client, bodies } = withSort("throughput");
    await client.completeWithTools(call);
    await client.complete({ model: "m", messages: [{ role: "user", content: "x" }], signal: call.signal, timeoutMs: 1_000, maxTokens: 10 });
    expect(bodies.map((b) => b.provider)).toEqual([{ sort: "throughput" }, { sort: "throughput" }]);
  });

  test("without a sort the request carries no provider field", async () => {
    const { client, bodies } = withSort(null);
    await client.completeWithTools(call);
    expect("provider" in bodies[0]!).toBe(false);
  });
});

describe("a reply cut off at the token limit", () => {
  test("with no content and no tool call it is an empty truncated turn, not a malformed failure", async () => {
    const { client } = clientReturning({ choices: [{ finish_reason: "length", message: { role: "assistant", content: "" } }] });
    const reply = await client.completeWithTools(call);
    expect(reply.finishReason).toBe("length");
    expect(reply.content).toBe("");
    expect(reply.toolCalls).toEqual([]);
  });

  test("an empty reply that was not truncated is still a malformed failure", async () => {
    const { client } = clientReturning({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "" } }] });
    await expect(client.completeWithTools(call)).rejects.toMatchObject({ kind: "malformed" });
  });

  test("a truncated reply that still has text is returned with its reason", async () => {
    const { client } = clientReturning({ choices: [{ finish_reason: "length", message: { role: "assistant", content: "Half a reply" } }] });
    expect(await client.completeWithTools(call)).toMatchObject({ content: "Half a reply", finishReason: "length" });
  });
});
