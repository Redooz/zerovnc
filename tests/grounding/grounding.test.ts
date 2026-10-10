import { describe, expect, test } from "bun:test";
import { GroundingService, MAX_CHOICE_CANDIDATES } from "../../src/application/grounding/grounding-service.ts";
import type { ModelRoute } from "../../src/application/models/route.ts";
import type { DecisionOutput, DecisionRequest } from "../../src/application/ports/decision-model.ts";
import { ModelCallError } from "../../src/application/ports/model-call-error.ts";
import { createObservation, type Observation, type ObservedElement } from "../../src/domain/perception/observation.ts";
import type { DecisionAnswer } from "../../src/domain/decisions/decision.ts";

const el = (id: string, kind: ObservedElement["kind"], label: string, extra: Partial<ObservedElement> = {}): ObservedElement => ({
  id,
  label,
  kind,
  value: { state: "not_applicable" },
  box: { x: 10, y: 10, w: 80, h: 30 },
  visible: true,
  ...extra,
});

function observation(elements: ObservedElement[]): Observation {
  return createObservation({
    id: "obs-1",
    taskId: "t1",
    capturedAt: new Date(0),
    width: 1280,
    height: 800,
    frameRevision: 1,
    screenshotRef: null,
    elements,
    relations: [],
  });
}

const meta = (model: string) => ({
  model,
  servedBy: model,
  promptVersion: "decision.v1",
  promptTokens: 1,
  completionTokens: 1,
  costUsd: 0,
  latencyMs: 1,
});

// Decision double that records the last request and returns a canned answer.
class FakeDecision implements ModelRoute<DecisionRequest, DecisionOutput> {
  requests: DecisionRequest[] = [];
  constructor(readonly model: string, private readonly answer: (r: DecisionRequest) => DecisionAnswer | Error) {}
  async call(request: DecisionRequest): Promise<DecisionOutput> {
    this.requests.push(request);
    const answer = this.answer(request);
    if (answer instanceof Error) throw answer;
    return { answer, metadata: meta(this.model) };
  }
}

const signal = () => new AbortController().signal;
const choice = (selected: string, ids: string[]): DecisionAnswer => ({
  kind: "choice",
  questionId: "select-control",
  selected,
  probabilities: Object.fromEntries(ids.map((id) => [id, id === selected ? 1 : 0])),
  confidence: 0.9,
  evidenceIds: [selected],
});

const SAVE_SCREEN = observation([
  el("e1", "button", "Cancelar"),
  el("e2", "button", "Guardar"),
  el("e3", "text_field", "Precio", { value: { state: "text", text: "19.90" } }),
]);

describe("selectControl", () => {
  test("the model chooses among observed candidates and the code resolves the element", async () => {
    const primary = new FakeDecision("jev", (r) => choice("e2", r.question.kind === "choice" ? r.question.options.map((o) => o.id) : []));
    const service = new GroundingService({ primary, fallback: new FakeDecision("luna", () => new Error("unused")), timeoutMs: 1000 });
    const outcome = await service.selectControl({ observation: SAVE_SCREEN, intent: "Guardar", signal: signal() });
    expect(outcome).toMatchObject({ status: "grounded", value: { id: "e2", label: "Guardar" }, servedBy: "jev" });
    // Candidates are only the visible controls, never the text field.
    const options = primary.requests[0]?.question.kind === "choice" ? primary.requests[0].question.options.map((o) => o.id) : [];
    expect(options).toEqual(["e1", "e2", "none", "insufficient_evidence"]);
  });

  test("coordinates never reach the decision model", async () => {
    const primary = new FakeDecision("jev", () => choice("e2", ["e1", "e2"]));
    const service = new GroundingService({ primary, fallback: primary, timeoutMs: 1000 });
    await service.selectControl({ observation: SAVE_SCREEN, intent: "Guardar", signal: signal() });
    const text = JSON.stringify(primary.requests[0]);
    expect(text).not.toMatch(/"x":|"box"/);
  });

  test("no candidates means no model call at all", async () => {
    const primary = new FakeDecision("jev", () => choice("x", []));
    const service = new GroundingService({ primary, fallback: primary, timeoutMs: 1000 });
    const outcome = await service.selectControl({ observation: observation([el("e1", "text", "Hola")]), intent: "x", signal: signal() });
    expect(outcome).toMatchObject({ status: "abstained", reason: "no_candidates" });
    expect(primary.requests.length).toBe(0);
  });

  test("the model may answer none or insufficient evidence", async () => {
    const none = new FakeDecision("jev", () => choice("none", ["e1", "e2", "none", "insufficient_evidence"]));
    const service = new GroundingService({ primary: none, fallback: none, timeoutMs: 1000 });
    expect(await service.selectControl({ observation: SAVE_SCREEN, intent: "Borrar", signal: signal() })).toMatchObject({ reason: "no_match" });

    const unsure = new FakeDecision("jev", () => choice("insufficient_evidence", ["e1", "e2", "none", "insufficient_evidence"]));
    const service2 = new GroundingService({ primary: unsure, fallback: unsure, timeoutMs: 1000 });
    expect(await service2.selectControl({ observation: SAVE_SCREEN, intent: "Guardar", signal: signal() })).toMatchObject({ reason: "insufficient_evidence" });
  });

  test("an answer that is not a valid choice is an invalid answer, not a guess", async () => {
    const bad = new FakeDecision("jev", () => ({
      kind: "choice",
      questionId: "select-control",
      selected: "e2",
      probabilities: { e1: 0.5, e2: 0.2, none: 0.2, insufficient_evidence: 0.1 },
      confidence: 0.9,
      evidenceIds: [],
    }));
    const service = new GroundingService({ primary: bad, fallback: bad, timeoutMs: 1000 });
    expect(await service.selectControl({ observation: SAVE_SCREEN, intent: "Guardar", signal: signal() })).toMatchObject({ reason: "invalid_answer" });
  });

  test("when the primary fails, the fallback answers and the fallback reason is reported", async () => {
    const primary = new FakeDecision("jev", () => new ModelCallError("provider", "HTTP 502"));
    const fallback = new FakeDecision("luna", () => choice("e2", ["e1", "e2", "none", "insufficient_evidence"]));
    const service = new GroundingService({ primary, fallback, timeoutMs: 1000 });
    const outcome = await service.selectControl({ observation: SAVE_SCREEN, intent: "Guardar", signal: signal() });
    expect(outcome).toMatchObject({ status: "grounded", servedBy: "luna", fallbackReason: "jev: provider" });
  });

  test("both models failing abstains with model_failed", async () => {
    const failing = new FakeDecision("jev", () => new ModelCallError("timeout", "slow"));
    const service = new GroundingService({ primary: failing, fallback: failing, timeoutMs: 1000 });
    expect(await service.selectControl({ observation: SAVE_SCREEN, intent: "Guardar", signal: signal() })).toMatchObject({ reason: "model_failed" });
  });

  test("too many candidates abstains instead of asking an unbounded question", async () => {
    const many = observation(Array.from({ length: MAX_CHOICE_CANDIDATES + 1 }, (_, i) => el(`b${i}`, "button", `Botón ${i}`)));
    const primary = new FakeDecision("jev", () => choice("b0", []));
    const service = new GroundingService({ primary, fallback: primary, timeoutMs: 1000 });
    expect(await service.selectControl({ observation: many, intent: "x", signal: signal() })).toMatchObject({ reason: "too_many_candidates" });
    expect(primary.requests.length).toBe(0);
  });
});

describe("selectField", () => {
  test("fields are the candidates, labels stay with their fields", async () => {
    const primary = new FakeDecision("jev", () => ({
      kind: "choice",
      questionId: "select-field",
      selected: "e3",
      probabilities: { e3: 1, none: 0, insufficient_evidence: 0 },
      confidence: 0.9,
      evidenceIds: ["e3"],
    }));
    const service = new GroundingService({ primary, fallback: primary, timeoutMs: 1000 });
    const outcome = await service.selectField({ observation: SAVE_SCREEN, intent: "Precio", signal: signal() });
    expect(outcome).toMatchObject({ status: "grounded", value: { id: "e3" } });
  });
});

describe("matchUniqueRecord (counted in code)", () => {
  const rows = (labels: string[]) => observation(labels.map((label, i) => el(`r${i}`, "table_row", label)));
  const service = new GroundingService({
    primary: new FakeDecision("jev", () => new Error("must not be called")),
    fallback: new FakeDecision("luna", () => new Error("must not be called")),
    timeoutMs: 1000,
  });

  test("one visible row with the identity is grounded", () => {
    const outcome = service.matchUniqueRecord({ observation: rows(["Ana Torres 555-0101", "Luis Pérez"]), identity: "Ana Torres" });
    expect(outcome).toMatchObject({ status: "grounded", value: { id: "r0" } });
  });

  test("two rows with the same identity are ambiguous and refused", () => {
    const outcome = service.matchUniqueRecord({ observation: rows(["Ana Torres 555-0101", "Ana Torres 555-0202"]), identity: "Ana Torres" });
    expect(outcome).toMatchObject({ status: "abstained", reason: "ambiguous" });
  });

  test("accents and case are ignored; whole words are required", () => {
    expect(service.matchUniqueRecord({ observation: rows(["JOSÉ GÓMEZ"]), identity: "jose gomez" })).toMatchObject({ status: "grounded" });
    expect(service.matchUniqueRecord({ observation: rows(["Ana Torresillas"]), identity: "Ana Torres" })).toMatchObject({ reason: "no_match" });
  });

  test("hidden rows do not count", () => {
    const hidden = observation([el("r0", "table_row", "Ana Torres", { visible: false, box: { x: 9000, y: 0, w: 1, h: 1 } })]);
    expect(service.matchUniqueRecord({ observation: hidden, identity: "Ana Torres" })).toMatchObject({ reason: "no_match" });
  });
});

describe("scoreTransition", () => {
  test("returns a level, and insufficient evidence abstains", async () => {
    const primary = new FakeDecision("jev", () => ({
      kind: "score",
      questionId: "transition-support",
      level: "supported",
      probabilities: { supported: 0.8, partial: 0.1, not_supported: 0.05, insufficient_evidence: 0.05 },
      confidence: 0.8,
      evidenceIds: ["e2"],
    }));
    const service = new GroundingService({ primary, fallback: primary, timeoutMs: 1000 });
    expect(await service.scoreTransition({ observation: SAVE_SCREEN, expectation: "the saved message is visible", signal: signal() })).toMatchObject({
      status: "scored",
      level: "supported",
    });

    const unsure = new FakeDecision("jev", () => ({
      kind: "score",
      questionId: "transition-support",
      level: "insufficient_evidence",
      probabilities: { supported: 0.05, partial: 0.05, not_supported: 0.1, insufficient_evidence: 0.8 },
      confidence: 0.4,
      evidenceIds: [],
    }));
    const service2 = new GroundingService({ primary: unsure, fallback: unsure, timeoutMs: 1000 });
    expect(await service2.scoreTransition({ observation: SAVE_SCREEN, expectation: "x", signal: signal() })).toMatchObject({ reason: "insufficient_evidence" });
  });
});

describe("threshold abstention with margin", () => {
  const twoSaves = observation([el("e1", "button", "Guardar"), el("e2", "button", "Guardar", { box: { x: 200, y: 10, w: 80, h: 30 } })]);
  const answerWith = (p1: number, p2: number) =>
    new FakeDecision("jev", () => ({
      kind: "choice",
      questionId: "select-control",
      selected: p1 >= p2 ? "e1" : "e2",
      probabilities: { e1: p1, e2: p2 },
      confidence: 0.5,
      evidenceIds: [],
    }));

  test("the question offers candidates only in threshold mode", async () => {
    const primary = answerWith(0.9, 0.1);
    const service = new GroundingService({ primary, fallback: primary, timeoutMs: 1000, abstention: { mode: "threshold", threshold: 0.5 } });
    await service.selectControl({ observation: twoSaves, intent: "Guardar", signal: signal() });
    const question = primary.requests[0]?.question;
    expect(question?.kind === "choice" ? question.options.map((o) => o.id) : []).toEqual(["e1", "e2"]);
  });

  test("a clear winner is grounded and reports its probability and margin", async () => {
    const primary = answerWith(0.85, 0.15);
    const distinct = observation([el("e1", "button", "Guardar"), el("e2", "button", "Cancelar", { box: { x: 200, y: 10, w: 80, h: 30 } })]);
    const service = new GroundingService({ primary, fallback: primary, timeoutMs: 1000, abstention: { mode: "threshold", threshold: 0.5, minMargin: 0.3 } });
    const outcome = await service.selectControl({ observation: distinct, intent: "Guardar", signal: signal() });
    expect(outcome).toMatchObject({ status: "grounded", probability: 0.85 });
    expect(outcome.status === "grounded" ? outcome.margin : null).toBeCloseTo(0.7);
  });

  test("a near-tie between duplicates abstains on margin even when the probability clears the threshold", async () => {
    const primary = answerWith(0.52, 0.48);
    const service = new GroundingService({ primary, fallback: primary, timeoutMs: 1000, abstention: { mode: "threshold", threshold: 0.5, minMargin: 0.3 } });
    expect(await service.selectControl({ observation: twoSaves, intent: "Guardar", signal: signal() })).toMatchObject({ status: "abstained", reason: "ambiguous_margin" });
  });

  test("below the probability threshold abstains", async () => {
    const primary = answerWith(0.6, 0.4);
    const service = new GroundingService({ primary, fallback: primary, timeoutMs: 1000, abstention: { mode: "threshold", threshold: 0.7 } });
    expect(await service.selectControl({ observation: twoSaves, intent: "Guardar", signal: signal() })).toMatchObject({ reason: "below_threshold" });
  });
});
