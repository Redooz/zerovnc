import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedPerception, perceptionCacheKey } from "../../evals/bench/perception-cache.ts";
import { recordDecisions, type DecisionTrace } from "../../evals/bench/recording.ts";
import { createFrozen, frozenMismatches } from "../../evals/bench/frozen.ts";
import { parsePromptFile } from "../../src/adapters/outbound/openrouter/prompt-file.ts";
import type { ModelRoute } from "../../src/application/models/route.ts";
import type { DecisionOutput, DecisionRequest } from "../../src/application/ports/decision-model.ts";
import type { PerceptionOutput, PerceptionRequest } from "../../src/application/ports/perception-model.ts";
import { ModelCallError } from "../../src/application/ports/model-call-error.ts";
import { createScreenshot } from "../../src/domain/desktop/screenshot.ts";

const shot = (fill: number) =>
  createScreenshot({ observationId: "o", capturedAt: new Date(0), width: 2, height: 2, frameRevision: 1, rgba: new Uint8Array(16).fill(fill) });
const meta = { model: "m", servedBy: "m", promptVersion: "p", promptTokens: 1, completionTokens: 1, costUsd: 0.01, latencyMs: 5 };

describe("perception cache", () => {
  test("a repeated screenshot is served from disk, so evidence is identical and costs nothing again", async () => {
    let calls = 0;
    const route: ModelRoute<PerceptionRequest, PerceptionOutput> = {
      model: "haiku",
      async call() {
        calls += 1;
        return { draft: { elements: [], relations: [], rejectedElements: calls }, metadata: meta };
      },
    };
    const stats = { hits: 0, misses: 0 };
    const cached = cachedPerception(route, mkdtempSync(join(tmpdir(), "pc-")), "perception.v1", stats);
    const request = (fill: number): PerceptionRequest => ({ observationId: "o", screenshot: shot(fill), signal: new AbortController().signal, timeoutMs: 1 });
    const first = await cached.call(request(7));
    const second = await cached.call(request(7));
    expect(second).toEqual(first);
    expect(calls).toBe(1);
    await cached.call(request(8));
    expect(calls).toBe(2);
    expect(stats).toEqual({ hits: 1, misses: 2 });
  });

  test("the key changes with the pixels, the model, and the prompt", () => {
    const r = (fill: number): PerceptionRequest => ({ observationId: "o", screenshot: shot(fill), signal: new AbortController().signal, timeoutMs: 1 });
    expect(perceptionCacheKey(r(1), "a")).not.toBe(perceptionCacheKey(r(2), "a"));
    expect(perceptionCacheKey(r(1), "a")).not.toBe(perceptionCacheKey(r(1), "b"));
    expect(perceptionCacheKey(r(1), "a")).toBe(perceptionCacheKey(r(1), "a"));
  });

  test("a failed perception is not cached", async () => {
    let calls = 0;
    const route: ModelRoute<PerceptionRequest, PerceptionOutput> = {
      model: "haiku",
      async call() {
        calls += 1;
        throw new ModelCallError("provider", "HTTP 502", true);
      },
    };
    const cached = cachedPerception(route, mkdtempSync(join(tmpdir(), "pc-")), "p", { hits: 0, misses: 0 });
    const request: PerceptionRequest = { observationId: "o", screenshot: shot(1), signal: new AbortController().signal, timeoutMs: 1 };
    await expect(cached.call(request)).rejects.toThrow();
    await expect(cached.call(request)).rejects.toThrow();
    expect(calls).toBe(2);
  });
});

describe("decision recording", () => {
  const question = { kind: "choice" as const, id: "q", text: "Which?", criteria: "c", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], abstention: "threshold" as const };
  const request: DecisionRequest = { question, evidence: [{ id: "a", text: 'button "A"' }], signal: new AbortController().signal, timeoutMs: 1 };
  const prompt = parsePromptFile("<!-- prompt-version: decision.vX -->\nRules.");

  test("records the exact wire question, state, and answer", async () => {
    const answer = { kind: "choice" as const, questionId: "q", selected: "a", probabilities: { a: 0.8, b: 0.2 }, confidence: 0.7, evidenceIds: ["a"] };
    const sink: DecisionTrace[] = [];
    const route = recordDecisions({ model: "jev", async call(): Promise<DecisionOutput> { return { answer, metadata: { ...meta, model: "jev", servedBy: "jev-1" } }; } }, sink, prompt);
    await route.call(request);
    expect(sink).toHaveLength(1);
    expect(sink[0]?.wire.criteria).toEqual({ a: "A", b: "B" });
    expect(sink[0]?.wire.instructions).toContain("Rules.");
    expect(sink[0]?.state).toContain('- a: button "A"');
    expect(sink[0]?.result).toMatchObject({ status: "ok", servedBy: "jev-1" });
  });

  test("records a failure with its kind and still rethrows it", async () => {
    const sink: DecisionTrace[] = [];
    const route = recordDecisions({ model: "luna", async call(): Promise<DecisionOutput> { throw new ModelCallError("provider", "provider returned HTTP 502", true); } }, sink, prompt);
    await expect(route.call(request)).rejects.toThrow("502");
    expect(sink[0]?.result).toMatchObject({ status: "error", kind: "provider", retryable: true });
  });
});

describe("frozen configuration", () => {
  const setup = { datasetHash: "h1", models: { decision: "jev-latest" }, prompts: { decision: "decision.v1" } };
  const frozen = createFrozen(setup, { a_jev: { threshold: 0.6, minMargin: 0.2 } }, "t");

  test("an unchanged setup has no mismatches", () => {
    expect(frozenMismatches(frozen, setup)).toEqual([]);
  });

  test("changed labels, models, or prompts block the held-out run", () => {
    expect(frozenMismatches(frozen, { ...setup, datasetHash: "h2" })).toEqual(["labelled cases changed since the freeze"]);
    expect(frozenMismatches(frozen, { ...setup, models: { decision: "other" } })[0]).toContain("model decision changed");
    expect(frozenMismatches(frozen, { ...setup, prompts: { decision: "decision.v2" } })[0]).toContain("prompt decision changed");
  });
});
