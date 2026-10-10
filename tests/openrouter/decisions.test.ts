import { afterEach, describe, expect, test } from "bun:test";
import { OpenRouterClient } from "../../src/adapters/outbound/openrouter/openrouter-client.ts";
import { OpenRouterDecisionModel, renderState, toWire } from "../../src/adapters/outbound/openrouter/decision-adapter.ts";
import { parsePromptFile } from "../../src/adapters/outbound/openrouter/prompt-file.ts";
import { ModelCallError } from "../../src/application/ports/model-call-error.ts";
import type { ChoiceQuestion } from "../../src/domain/decisions/decision.ts";

const KEY = "sk-or-test-key-do-not-leak-456";
let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => {
  server?.stop(true);
  server = null;
});

function serve(handler: (req: Request, body: any) => Response | Promise<Response>): string {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => handler(req, req.method === "POST" ? await req.json() : null),
  });
  return `http://localhost:${server.port}/api/v1`;
}

const QUESTION: ChoiceQuestion = {
  kind: "choice",
  id: "select-control",
  text: "Which control saves?",
  criteria: "label matches Guardar",
  options: [
    { id: "e1", label: "Cancelar" },
    { id: "e2", label: "Guardar" },
    { id: "none", label: "none" },
    { id: "insufficient_evidence", label: "unclear" },
  ],
};
const EVIDENCE = [
  { id: "e1", text: 'button "Cancelar"' },
  { id: "e2", text: 'button "Guardar"' },
];

describe("OpenRouterClient.decide", () => {
  test("posts to the Decisions API path, outside /api/v1, with the key only in the header", async () => {
    let path = "";
    let auth = "";
    const base = serve((req) => {
      path = new URL(req.url).pathname;
      auth = req.headers.get("authorization") ?? "";
      return Response.json({
        model: "openai/gpt-6-luna-decisions-20261006",
        answers: { q: { type: "choice", choice: "e2", probabilities: { e1: 0.1, e2: 0.9 }, confidence: 0.9 } },
        usage: { input_tokens: 100, output_tokens: 0, cost: 0.00001 },
      });
    });
    const reply = await new OpenRouterClient(KEY, base).decide({
      model: "jev-latest",
      state: "s",
      questions: {},
      signal: new AbortController().signal,
      timeoutMs: 2000,
    });
    expect(path).toBe("/api/alpha/decisions");
    expect(auth).toBe(`Bearer ${KEY}`);
    expect(reply).toMatchObject({ servedBy: "openai/gpt-6-luna-decisions-20261006", promptTokens: 100, completionTokens: 0, costUsd: 0.00001 });
  });

  test("an HTTP error from the Decisions API is a provider failure without the key", async () => {
    const base = serve(() => new Response(`no ${KEY}`, { status: 400 }));
    try {
      await new OpenRouterClient(KEY, base).decide({ model: "jev-latest", state: "s", questions: {}, signal: new AbortController().signal, timeoutMs: 2000 });
      throw new Error("expected failure");
    } catch (error) {
      expect((error as ModelCallError).kind).toBe("provider");
      expect((error as Error).message).not.toContain(KEY);
    }
  });
});

describe("OpenRouterDecisionModel", () => {
  test("sends evidence as state and the question in its wire shape, and maps the answer", async () => {
    let body: any = null;
    const base = serve((_req, parsed) => {
      body = parsed;
      return Response.json({
        model: "jev-latest",
        answers: { "select-control": { type: "choice", choice: "e2", probabilities: { e1: 0.05, e2: 0.9, none: 0.03, insufficient_evidence: 0.02 }, confidence: 0.88 } },
        usage: { input_tokens: 50, output_tokens: 0, cost: 0.00002 },
      });
    });
    const model = new OpenRouterDecisionModel(new OpenRouterClient(KEY, base), "jev-latest", parsePromptFile("<!-- prompt-version: decision.v9 -->\nRules."));
    const out = await model.call({ question: QUESTION, evidence: EVIDENCE, signal: new AbortController().signal, timeoutMs: 2000 });

    expect(body.model).toBe("jev-latest");
    expect(body.state).toContain("- e2: button \"Guardar\"");
    // The intent lives in the state: the Decisions API barely reads the separate question field.
    expect(body.state).toContain("Question: Which control saves?");
    expect(body.questions["select-control"].type).toBe("choice");
    expect(body.questions["select-control"].criteria).toEqual({ e1: "Cancelar", e2: "Guardar", none: "none", insufficient_evidence: "unclear" });
    expect(body.questions["select-control"].instructions).toContain("Rules.");
    expect(out.answer).toMatchObject({ kind: "choice", selected: "e2", evidenceIds: ["e2"] });
    expect(out.metadata).toMatchObject({ model: "jev-latest", promptVersion: "decision.v9", costUsd: 0.00002 });
  });

  test("a score question is sent as an ordered criteria array", () => {
    const wire = toWire({ kind: "score", id: "s", text: "t", criteria: "c", levels: [{ id: "a", label: "A" }, { id: "insufficient_evidence", label: "?" }] }, "p");
    expect(wire).toMatchObject({ type: "score", criteria: ["A", "?"] });
  });

  test("the state carries the question and criteria with the evidence, so the intent is judged", () => {
    expect(renderState(QUESTION, EVIDENCE)).toBe(
      'Question: Which control saves?\nCriteria: label matches Guardar\nEvidence (refer to items by id):\n- e1: button "Cancelar"\n- e2: button "Guardar"',
    );
  });
});
