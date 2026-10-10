import type { ModelRoute } from "../../../application/models/route.ts";
import type { DecisionOutput, DecisionRequest, EvidenceItem } from "../../../application/ports/decision-model.ts";
import type { DecisionQuestion } from "../../../domain/decisions/decision.ts";
import { OpenRouterClient, type ContentPart, type DecisionQuestionWire } from "./openrouter-client.ts";
import { BOOLEAN_OPTIONS, mapDecisionAnswer } from "./decision-mapper.ts";
import { loadPromptFile, type PromptFile } from "./prompt-file.ts";

// Decision questions through the OpenRouter Decisions API (JEV or the Luna fallback).
// The model identifier is supplied by configuration; this class has no default.
export class OpenRouterDecisionModel implements ModelRoute<DecisionRequest, DecisionOutput> {
  private readonly prompt: PromptFile;

  constructor(
    private readonly client: OpenRouterClient,
    readonly model: string,
    prompt: PromptFile = loadPromptFile("decision.v1.md"),
  ) {
    this.prompt = prompt;
  }

  async call(request: DecisionRequest): Promise<DecisionOutput> {
    const { question } = request;
    const reply = await this.client.decide({
      model: this.model,
      state: request.image === undefined ? renderState(question, request.evidence) : withImage(renderState(question, request.evidence), request.image),
      questions: { [question.id]: toWire(question, this.prompt.text) },
      signal: request.signal,
      timeoutMs: request.timeoutMs,
    });

    const answer = mapDecisionAnswer(reply.answers, question, request.evidence);
    return {
      answer,
      metadata: {
        model: this.model,
        servedBy: reply.servedBy,
        promptVersion: this.prompt.version,
        promptTokens: reply.promptTokens,
        completionTokens: reply.completionTokens,
        costUsd: reply.costUsd,
        latencyMs: reply.latencyMs,
      },
    };
  }
}

// Builds the wire question. The prompt text is the shared instruction preamble;
// the question's own criteria follow it.
export function toWire(question: DecisionQuestion, preamble: string): DecisionQuestionWire {
  const instructions = `${preamble}\n\nCriteria: ${question.criteria}`;
  if (question.kind === "boolean") {
    return {
      type: "choice",
      question: question.text,
      instructions,
      criteria: {
        [BOOLEAN_OPTIONS[0]]: "Yes: the criteria are met by the evidence.",
        [BOOLEAN_OPTIONS[1]]: "No: the criteria are not met by the evidence.",
        [BOOLEAN_OPTIONS[2]]: "Insufficient evidence: the evidence is missing, unreadable, or ambiguous.",
      },
    };
  }
  if (question.kind === "choice") {
    return {
      type: "choice",
      question: question.text,
      instructions,
      criteria: Object.fromEntries(question.options.map((option) => [option.id, option.label])),
    };
  }
  return {
    type: "score",
    question: question.text,
    instructions,
    criteria: question.levels.map((level) => level.label),
  };
}

// What the Decisions API judges. The API weighs the state against the criteria and
// barely reads the separate `question` field (verified live: with the intent only in
// `question`, JEV picked the same candidate for every intent; with the intent in the
// state it followed the intent every time). So the state carries the question, its
// criteria, and the evidence the model may choose from, one item per line, by id.
export function renderState(question: DecisionQuestion, evidence: readonly EvidenceItem[]): string {
  return [
    `Question: ${question.text}`,
    `Criteria: ${question.criteria}`,
    "Evidence (refer to items by id):",
    ...evidence.map((item) => `- ${item.id}: ${item.text}`),
  ].join("\n");
}

// Text plus one PNG, as the Decisions API accepts image input in state.
export function withImage(text: string, png: Uint8Array): ContentPart[] {
  return [
    { type: "text", text },
    { type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from(png).toString("base64")}` } },
  ];
}
