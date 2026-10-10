import { describe, expect, test } from "bun:test";
import { buildNumberedCandidates, resolveNumberedChoice } from "../../src/application/grounding/numbered-candidates.ts";
import { createObservation, type ObservedElement } from "../../src/domain/perception/observation.ts";

const el = (id: string, kind: ObservedElement["kind"], label: string, x: number, y: number): ObservedElement => ({
  id,
  label,
  kind,
  value: { state: "not_applicable" },
  box: { x, y, w: 60, h: 20 },
  visible: true,
});
const observation = createObservation({
  id: "o1",
  taskId: "t",
  capturedAt: new Date(0),
  width: 1280,
  height: 800,
  frameRevision: 1,
  screenshotRef: null,
  elements: [el("a", "button", "Guardar", 300, 200), el("b", "button", "Cancelar", 100, 50), el("c", "text", "Precio", 10, 10)],
  relations: [],
});

describe("numbered candidates", () => {
  test("numbers only visible candidates of the requested kinds, top-left to bottom-right", () => {
    const result = buildNumberedCandidates(observation, "Guardar", ["button"], "control");
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.candidates.entries.map((e) => [e.number, e.element.id])).toEqual([
      [1, "b"],
      [2, "a"],
    ]);
    expect(result.candidates.overlay.map((o) => o.number)).toEqual([1, 2]);
  });

  test("the question offers numbered options plus the abstention options", () => {
    const result = buildNumberedCandidates(observation, "Guardar", ["button"], "control");
    if (result.status !== "ready") throw new Error("expected ready");
    expect(result.candidates.question.options.map((o) => o.id)).toEqual(["n1", "n2", "none", "insufficient_evidence"]);
    expect(result.candidates.evidence.map((e) => e.id)).toEqual(["n1", "n2"]);
  });

  test("no candidates abstains without a model call", () => {
    expect(buildNumberedCandidates(observation, "x", ["checkbox"], "control")).toMatchObject({ status: "abstained", reason: "no_candidates" });
  });

  test("a chosen number resolves to the element drawn on it", () => {
    const result = buildNumberedCandidates(observation, "Guardar", ["button"], "control");
    if (result.status !== "ready") throw new Error("expected ready");
    expect(resolveNumberedChoice(result.candidates, "n2")).toMatchObject({ status: "grounded", element: { id: "a" }, number: 2 });
    expect(resolveNumberedChoice(result.candidates, "none")).toMatchObject({ reason: "no_match" });
    expect(resolveNumberedChoice(result.candidates, "insufficient_evidence")).toMatchObject({ reason: "insufficient_evidence" });
    expect(resolveNumberedChoice(result.candidates, "n9")).toMatchObject({ reason: "invalid_answer" });
  });
});

describe("captions from label relations", () => {
  test("a field gets its caption from the labels relation; a field without one gets none", async () => {
    const { labelTextFor, describeInContext } = await import("../../src/application/grounding/grounding-service.ts");
    const withRelation = createObservation({
      id: "o2",
      taskId: "t",
      capturedAt: new Date(0),
      width: 1280,
      height: 800,
      frameRevision: 1,
      screenshotRef: null,
      elements: [
        el("cap", "label", "NIT *", 20, 150),
        { ...el("fld", "text_field", "", 20, 170), value: { state: "empty" } },
        el("lone", "text_field", "", 500, 170),
      ],
      relations: [{ kind: "labels", from: "cap", to: "fld" }],
    });
    const field = withRelation.elements.find((e) => e.id === "fld")!;
    const lone = withRelation.elements.find((e) => e.id === "lone")!;
    expect(labelTextFor(withRelation, field)).toBe("NIT *");
    expect(labelTextFor(withRelation, lone)).toBeNull();
    expect(describeInContext(withRelation, field)).toContain('captioned "NIT *"');
  });
});

describe("duplicate targets are refused", () => {
  test("two identical controls: the text path abstains as ambiguous_duplicate", async () => {
    const { GroundingService } = await import("../../src/application/grounding/grounding-service.ts");
    const dup = createObservation({
      id: "d",
      taskId: "t",
      capturedAt: new Date(0),
      width: 1280,
      height: 800,
      frameRevision: 1,
      screenshotRef: null,
      elements: [el("a", "button", "Guardar", 100, 700), el("b", "button", "guardar", 300, 700)],
      relations: [],
    });
    const route = {
      model: "m",
      async call() {
        return {
          answer: { kind: "choice" as const, questionId: "select-control", selected: "a", probabilities: { a: 0.95, b: 0.02, none: 0.02, insufficient_evidence: 0.01 }, confidence: 0.9, evidenceIds: ["a"] },
          metadata: { model: "m", servedBy: "m", promptVersion: "v", promptTokens: 1, completionTokens: 1, costUsd: 0, latencyMs: 1 },
        };
      },
    };
    const service = new GroundingService({ primary: route, fallback: route, timeoutMs: 1000 });
    const outcome = await service.selectControl({ observation: dup, intent: "Guardar", signal: new AbortController().signal });
    expect(outcome).toMatchObject({ status: "abstained", reason: "ambiguous_duplicate" });
  });

  test("a distinct control is not treated as a duplicate", async () => {
    const { duplicateOf } = await import("../../src/application/grounding/grounding-service.ts");
    const a = el("a", "button", "Guardar", 100, 700);
    expect(duplicateOf(a, [a, el("b", "button", "Cancelar", 300, 700)])).toBeNull();
    expect(duplicateOf(a, [a, el("c", "link", "Guardar", 300, 700)])).toBeNull();
  });
});
