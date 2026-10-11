import { encodeRgbaPng } from "../artifacts/png-encoder.ts";
import type { ModelRoute } from "../../../application/models/route.ts";
import type { PerceptionOutput, PerceptionRequest } from "../../../application/ports/perception-model.ts";
import { ModelCallError } from "../../../application/ports/model-call-error.ts";
import { OpenRouterClient } from "./openrouter-client.ts";
import { loadPromptFile, type PromptFile } from "./prompt-file.ts";
import { mapPerceptionReply } from "./perception-mapper.ts";

// Current perception prompt file. Bump the file name and its version line together; the
// version is recorded in traces and keys the benchmark's perception cache.
export const PERCEPTION_PROMPT_FILE = "perception.v5.md";
// Large tables can produce long replies; a reply that still hits this limit is rejected
// as truncated rather than parsed from a cut-off string.
export const PERCEPTION_MAX_TOKENS = 8_000;

// Perception through one OpenRouter vision model. The model identifier is supplied
// by configuration; this class has no default.
export class OpenRouterPerceptionModel implements ModelRoute<PerceptionRequest, PerceptionOutput> {
  private readonly prompt: PromptFile;

  constructor(
    private readonly client: OpenRouterClient,
    readonly model: string,
    prompt: PromptFile = loadPromptFile(PERCEPTION_PROMPT_FILE),
    // Place a provider cache breakpoint after the stable instructions. Only for routes
    // that support explicit breakpoints (verified live for Anthropic Haiku); never assumed.
    private readonly cacheBreakpoint: boolean = false,
  ) {
    this.prompt = prompt;
  }

  async call(request: PerceptionRequest): Promise<PerceptionOutput> {
    const { screenshot } = request;
    const png = encodeRgbaPng(screenshot.width, screenshot.height, screenshot.rgba);
    const dataUrl = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;

    const reply = await this.client.complete({
      model: this.model,
      signal: request.signal,
      timeoutMs: request.timeoutMs,
      maxTokens: PERCEPTION_MAX_TOKENS,
      messages: [
        // The system prompt is the stable prefix; the breakpoint goes after it, before the
        // screenshot and observation id, which change on every call.
        {
          role: "system",
          content: this.cacheBreakpoint
            ? [{ type: "text", text: this.prompt.text, cache_control: { type: "ephemeral" } }]
            : this.prompt.text,
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Observation ${request.observationId}. Image size ${screenshot.width}x${screenshot.height} pixels. Return the JSON object described in the instructions.`,
            },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    });

    if (reply.finishReason === "length") {
      throw new ModelCallError("malformed", "perception reply was truncated at the token limit");
    }
    const draft = mapPerceptionReply(reply.content, { width: screenshot.width, height: screenshot.height });
    return {
      draft,
      metadata: {
        model: this.model,
        servedBy: reply.servedBy,
        promptVersion: this.prompt.version,
        promptTokens: reply.promptTokens,
        completionTokens: reply.completionTokens,
        cacheReadTokens: reply.cacheReadTokens,
        cacheWriteTokens: reply.cacheWriteTokens,
        costUsd: reply.costUsd,
        latencyMs: reply.latencyMs,
      },
    };
  }
}
