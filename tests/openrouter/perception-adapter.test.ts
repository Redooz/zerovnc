import { afterEach, describe, expect, test } from "bun:test";
import { OpenRouterClient } from "../../src/adapters/outbound/openrouter/openrouter-client.ts";
import { OpenRouterPerceptionModel, PERCEPTION_PROMPT_FILE } from "../../src/adapters/outbound/openrouter/perception-adapter.ts";
import { loadPromptFile, parsePromptFile } from "../../src/adapters/outbound/openrouter/prompt-file.ts";
import { createScreenshot } from "../../src/domain/desktop/screenshot.ts";

let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => {
  server?.stop(true);
  server = null;
});

function serve(content: string, finishReason: string): string {
  server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ model: "m", choices: [{ finish_reason: finishReason, message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }),
  });
  return `http://localhost:${server.port}/api/v1`;
}

const shot = createScreenshot({ observationId: "o", capturedAt: new Date(0), width: 2, height: 2, frameRevision: 1, rgba: new Uint8Array(16) });
const request = { observationId: "o", screenshot: shot, signal: new AbortController().signal, timeoutMs: 5000 };
const prompt = parsePromptFile("<!-- prompt-version: perception.vT -->\nRules.");

describe("perception adapter", () => {
  test("a reply cut off at the token limit is rejected as truncated, not parsed", async () => {
    // Valid-looking JSON that stopped because of the limit must still be refused.
    const base = serve('{"elements":[],"relations":[]}', "length");
    const model = new OpenRouterPerceptionModel(new OpenRouterClient("k", base), "m", prompt);
    await expect(model.call(request)).rejects.toMatchObject({ kind: "malformed" });
  });

  test("a complete reply is mapped", async () => {
    const base = serve('{"elements":[],"relations":[]}', "stop");
    const model = new OpenRouterPerceptionModel(new OpenRouterClient("k", base), "m", prompt);
    const out = await model.call(request);
    expect(out.metadata.promptVersion).toBe("perception.vT");
  });

  test("the shipped prompt tells the model not to enumerate every table cell", () => {
    const shipped = loadPromptFile(PERCEPTION_PROMPT_FILE);
    expect(shipped.version).toBe("perception.v5");
    expect(shipped.text).toContain("table_row");
    expect(shipped.text).toContain("do not list every cell");
    expect(shipped.text).toContain('"d":1');
    expect(shipped.text).toContain("currently selected option");
  });
});
