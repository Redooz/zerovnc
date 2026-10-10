import { describe, expect, test } from "bun:test";
import { createScreenshot } from "../../src/domain/desktop/screenshot.ts";
import { PerceiveScreen } from "../../src/application/perception/perceive-screen.ts";
import { callWithFallback, type ModelRoute } from "../../src/application/models/route.ts";
import { ModelCallError } from "../../src/application/ports/model-call-error.ts";
import type { PerceptionOutput, PerceptionRequest } from "../../src/application/ports/perception-model.ts";

const ELEMENT = {
  id: "e1",
  label: "Guardar",
  kind: "button" as const,
  value: { state: "not_applicable" as const },
  box: { x: 10, y: 10, w: 80, h: 30 },
  visible: true,
};

function metadata(model: string) {
  return { model, servedBy: model, promptVersion: "perception.v1", promptTokens: 10, completionTokens: 5, costUsd: 0.001, latencyMs: 12 };
}

class FakeRoute<Req, Res> implements ModelRoute<Req, Res> {
  calls = 0;
  constructor(readonly model: string, private readonly behavior: () => Promise<Res> | Res) {}
  async call(): Promise<Res> {
    this.calls += 1;
    return this.behavior();
  }
}

const screenshot = createScreenshot({
  observationId: "obs-1",
  capturedAt: new Date(0),
  width: 1280,
  height: 800,
  frameRevision: 1,
  rgba: new Uint8Array(1280 * 800 * 4),
});

const okOutput = (model: string): PerceptionOutput => ({
  draft: { elements: [ELEMENT], relations: [], rejectedElements: 0 },
  metadata: metadata(model),
});

describe("callWithFallback", () => {
  const request = {} as PerceptionRequest;
  test("uses the primary when it succeeds", async () => {
    const primary = new FakeRoute("primary", () => okOutput("primary"));
    const fallback = new FakeRoute("fallback", () => okOutput("fallback"));
    const out = await callWithFallback(primary, fallback, request, new AbortController().signal);
    expect(out.servedBy).toBe("primary");
    expect(out.fallbackReason).toBeNull();
    expect(fallback.calls).toBe(0);
  });

  test("falls back on a provider failure and records why", async () => {
    const primary = new FakeRoute("primary", () => {
      throw new ModelCallError("provider", "HTTP 503");
    });
    const fallback = new FakeRoute("fallback", () => okOutput("fallback"));
    const out = await callWithFallback(primary, fallback, request, new AbortController().signal);
    expect(out.servedBy).toBe("fallback");
    expect(out.fallbackReason).toBe("primary: provider");
  });

  test("a cancelled request is never retried on the fallback", async () => {
    const controller = new AbortController();
    const primary = new FakeRoute("primary", () => {
      controller.abort();
      throw new ModelCallError("cancelled", "cancelled");
    });
    const fallback = new FakeRoute("fallback", () => okOutput("fallback"));
    await expect(callWithFallback(primary, fallback, request, controller.signal)).rejects.toThrow(ModelCallError);
    expect(fallback.calls).toBe(0);
  });

  test("non-model errors are not swallowed", async () => {
    const primary = new FakeRoute("primary", () => {
      throw new Error("bug");
    });
    const fallback = new FakeRoute("fallback", () => okOutput("fallback"));
    await expect(callWithFallback(primary, fallback, request, new AbortController().signal)).rejects.toThrow("bug");
    expect(fallback.calls).toBe(0);
  });
});

describe("PerceiveScreen", () => {
  test("returns an observation built from the model draft", async () => {
    const primary = new FakeRoute("haiku", () => okOutput("haiku"));
    const fallback = new FakeRoute("deepseek", () => okOutput("deepseek"));
    const perceive = new PerceiveScreen({ primary, fallback, timeoutMs: 1000 });
    const outcome = await perceive.perceive({ taskId: "t1", screenshot, signal: new AbortController().signal });
    expect(outcome.status).toBe("observed");
    if (outcome.status === "observed") {
      expect(outcome.observation.id).toBe("obs-1");
      expect(outcome.observation.elements[0]?.label).toBe("Guardar");
      expect(outcome.metadata.promptVersion).toBe("perception.v1");
    }
  });

  test("abstains when both models fail, without guessing", async () => {
    const failing = () => {
      throw new ModelCallError("provider", "HTTP 500");
    };
    const perceive = new PerceiveScreen({
      primary: new FakeRoute("haiku", failing),
      fallback: new FakeRoute("deepseek", failing),
      timeoutMs: 1000,
    });
    const outcome = await perceive.perceive({ taskId: "t1", screenshot, signal: new AbortController().signal });
    expect(outcome).toMatchObject({ status: "abstained", reason: "model_failed" });
  });

  test("abstains when nothing could be grounded", async () => {
    const empty: PerceptionOutput = { draft: { elements: [], relations: [], rejectedElements: 3 }, metadata: metadata("haiku") };
    const perceive = new PerceiveScreen({
      primary: new FakeRoute("haiku", () => empty),
      fallback: new FakeRoute("deepseek", () => empty),
      timeoutMs: 1000,
    });
    const outcome = await perceive.perceive({ taskId: "t1", screenshot, signal: new AbortController().signal });
    expect(outcome).toMatchObject({ status: "abstained", reason: "no_grounded_elements" });
  });

  test("abstains with unreadable_output when the draft contradicts itself", async () => {
    const dup: PerceptionOutput = {
      draft: { elements: [ELEMENT, { ...ELEMENT, id: "e1" }], relations: [], rejectedElements: 0 },
      metadata: metadata("haiku"),
    };
    const perceive = new PerceiveScreen({
      primary: new FakeRoute("haiku", () => dup),
      fallback: new FakeRoute("deepseek", () => dup),
      timeoutMs: 1000,
    });
    const outcome = await perceive.perceive({ taskId: "t1", screenshot, signal: new AbortController().signal });
    expect(outcome).toMatchObject({ status: "abstained", reason: "unreadable_output" });
  });
});
