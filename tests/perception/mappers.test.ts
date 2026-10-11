import { describe, expect, test } from "bun:test";
import { mapPerceptionReply } from "../../src/adapters/outbound/openrouter/perception-mapper.ts";
import { mapDecisionAnswer } from "../../src/adapters/outbound/openrouter/decision-mapper.ts";
import { parsePromptFile, loadPromptFile } from "../../src/adapters/outbound/openrouter/prompt-file.ts";
import { ModelCallError } from "../../src/application/ports/model-call-error.ts";
import type { BooleanQuestion, ChoiceQuestion, ScoreQuestion } from "../../src/domain/decisions/decision.ts";

const SCREEN = { width: 1280, height: 800 };
const reply = (elements: unknown[], relations: unknown[] = []) => JSON.stringify({ elements, relations });
const good = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  label: "Guardar",
  kind: "button",
  value: { state: "not_applicable" },
  box: { x: 10, y: 10, w: 80, h: 30 },
  visible: true,
  ...extra,
});

describe("perception mapper", () => {
  test("maps grounded elements and keeps relations between them", () => {
    const draft = mapPerceptionReply(
      reply(
        [
          good("e1", { label: "Precio", kind: "label" }),
          good("e2", { label: "19.90", kind: "text_field", value: { state: "text", text: "19.90" } }),
        ],
        [{ kind: "labels", from: "e1", to: "e2" }],
      ),
      SCREEN,
    );
    expect(draft.elements.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(draft.relations).toEqual([{ kind: "labels", from: "e1", to: "e2" }]);
    expect(draft.rejectedElements).toBe(0);
  });

  test("accepts a fenced JSON reply", () => {
    const fenced = "```json\n" + reply([good("e1")]) + "\n```";
    expect(mapPerceptionReply(fenced, SCREEN).elements).toHaveLength(1);
  });

  test("drops and counts elements whose boxes cannot be grounded", () => {
    const draft = mapPerceptionReply(
      reply([good("e1"), good("e2", { box: { x: 1250, y: 0, w: 80, h: 30 } }), good("e3", { box: { x: 1.5, y: 0, w: 4, h: 4 } })]),
      SCREEN,
    );
    expect(draft.elements.map((e) => e.id)).toEqual(["e1"]);
    expect(draft.rejectedElements).toBe(2);
  });

  test("rejects every copy of a duplicated id", () => {
    const draft = mapPerceptionReply(reply([good("e1"), good("e1", { label: "Otro" })]), SCREEN);
    expect(draft.elements).toHaveLength(0);
    expect(draft.rejectedElements).toBe(2);
  });

  test("drops relations that point at rejected elements", () => {
    const draft = mapPerceptionReply(
      reply([good("e1"), good("e2", { box: { x: 5000, y: 0, w: 1, h: 1 } })], [{ kind: "labels", from: "e1", to: "e2" }]),
      SCREEN,
    );
    expect(draft.relations).toEqual([]);
  });

  test("an unreadable value is kept as unknown", () => {
    const draft = mapPerceptionReply(reply([good("e1", { kind: "text_field", value: { state: "unknown" } })]), SCREEN);
    expect(draft.elements[0]?.value).toEqual({ state: "unknown" });
  });

  test("malformed envelopes fail the whole reply as malformed", () => {
    expect(() => mapPerceptionReply("not json", SCREEN)).toThrow(ModelCallError);
    expect(() => mapPerceptionReply('{"items": []}', SCREEN)).toThrow(ModelCallError);
    try {
      mapPerceptionReply("nope", SCREEN);
    } catch (error) {
      expect((error as ModelCallError).kind).toBe("malformed");
    }
  });
});

const CHOICE: ChoiceQuestion = {
  kind: "choice",
  id: "select-control",
  text: "t",
  criteria: "c",
  options: [
    { id: "e1", label: "a" },
    { id: "e2", label: "b" },
    { id: "none", label: "none" },
    { id: "insufficient_evidence", label: "unclear" },
  ],
};
const BOOL: BooleanQuestion = { kind: "boolean", id: "unique", text: "t", criteria: "c" };
const SCORE: ScoreQuestion = {
  kind: "score",
  id: "transition",
  text: "t",
  criteria: "c",
  levels: [
    { id: "supported", label: "supported" },
    { id: "partial", label: "partial" },
    { id: "insufficient_evidence", label: "unclear" },
  ],
};
const EVIDENCE = [
  { id: "e1", text: "button a" },
  { id: "e2", text: "button b" },
];

describe("decision mapper (Decisions API wire shapes)", () => {
  test("maps a choice answer and cites the selected candidate", () => {
    const answer = mapDecisionAnswer(
      { "select-control": { type: "choice", choice: "e1", probabilities: { e1: 0.9, e2: 0.05, none: 0.03, insufficient_evidence: 0.02 }, confidence: 0.9 } },
      CHOICE,
      EVIDENCE,
    );
    expect(answer).toMatchObject({ kind: "choice", selected: "e1", evidenceIds: ["e1"] });
  });

  test("maps a boolean question sent as yes/no/insufficient_evidence", () => {
    const answer = mapDecisionAnswer(
      { unique: { type: "choice", choice: "no", probabilities: { yes: 0.1, no: 0.85, insufficient_evidence: 0.05 }, confidence: 0.8 } },
      BOOL,
      EVIDENCE,
    );
    expect(answer).toMatchObject({ kind: "boolean", answer: "no", probabilityYes: 0.1, evidenceIds: [] });
  });

  test("maps a score answer from index-keyed probabilities to level ids", () => {
    const answer = mapDecisionAnswer(
      { transition: { type: "score", score: 0.1, legend: { "0": "supported", "1": "partial", "2": "unclear" }, probabilities: { "0": 0.8, "1": 0.15, "2": 0.05 }, confidence: 0.7 } },
      SCORE,
      EVIDENCE,
    );
    expect(answer).toMatchObject({ kind: "score", level: "supported", evidenceIds: [] });
  });

  test("a missing answer for the question is malformed", () => {
    expect(() => mapDecisionAnswer({}, CHOICE, EVIDENCE)).toThrow(ModelCallError);
  });

  test("a choice outside the question's options is malformed", () => {
    try {
      mapDecisionAnswer(
        { "select-control": { type: "choice", choice: "zz", probabilities: { e1: 0.5, e2: 0.2, none: 0.2, insufficient_evidence: 0.1 }, confidence: 0.9 } },
        CHOICE,
        EVIDENCE,
      );
      throw new Error("expected failure");
    } catch (error) {
      expect((error as ModelCallError).kind).toBe("malformed");
    }
  });

  test("probabilities that do not sum to one are malformed", () => {
    try {
      mapDecisionAnswer(
        { "select-control": { type: "choice", choice: "e1", probabilities: { e1: 0.5, e2: 0.2, none: 0.1, insufficient_evidence: 0.1 }, confidence: 0.9 } },
        CHOICE,
        EVIDENCE,
      );
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelCallError);
      expect((error as ModelCallError).kind).toBe("malformed");
    }
  });

  test("a missing confidence is malformed", () => {
    expect(() =>
      mapDecisionAnswer({ unique: { type: "choice", choice: "no", probabilities: { yes: 0.1, no: 0.9, insufficient_evidence: 0 } } }, BOOL, EVIDENCE),
    ).toThrow(ModelCallError);
  });
});

describe("prompt files", () => {
  test("the version is read from the first line", () => {
    const prompt = parsePromptFile("<!-- prompt-version: perception.v9 -->\nHello");
    expect(prompt).toEqual({ version: "perception.v9", text: "Hello" });
  });

  test("a file without a version line is rejected", () => {
    expect(() => parsePromptFile("no version here")).toThrow(/prompt-version/);
  });

  test("the shipped prompts declare versions", () => {
    expect(loadPromptFile("perception.v3.md").version).toBe("perception.v3");
    expect(loadPromptFile("perception.v4.md").version).toBe("perception.v4");
    expect(loadPromptFile("perception.v5.md").version).toBe("perception.v5");
    expect(loadPromptFile("decision.v1.md").version).toBe("decision.v1");
  });
});

describe("perception rejections are explained", () => {
  test("each rejected element says why", () => {
    const draft = mapPerceptionReply(
      reply([good("e1"), good("e2", { box: { x: 1250, y: 0, w: 80, h: 30 } }), { id: "e3", label: "x", kind: "nonsense", value: { state: "unknown" }, box: { x: 1, y: 1, w: 5, h: 5 }, visible: true }, good("e4"), good("e4")]),
      SCREEN,
    );
    expect(draft.rejectedElements).toBe(4);
    const notes = (draft.rejections ?? []).join(" | ");
    expect(notes).toContain("e2: element \"e2\": visible box extends outside the screen");
    expect(notes).toContain("e3: schema kind");
    expect(notes).toContain("e4: duplicate id");
  });
});

describe("value-only defects", () => {
  test("an element with an invented value state is kept, with its value recorded as unknown", () => {
    const draft = mapPerceptionReply(reply([good("e1", { kind: "dropdown", label: "Ciudad", value: { state: "selected", text: "Bogotá" } })]), SCREEN);
    expect(draft.rejectedElements).toBe(0);
    expect(draft.elements[0]).toMatchObject({ id: "e1", kind: "dropdown", value: { state: "unknown" } });
    expect((draft.rejections ?? []).join(" ")).toContain("value repaired to unknown");
  });

  test("an element with a bad box is still rejected, even if its value is also bad", () => {
    const draft = mapPerceptionReply(reply([good("e1", { value: { state: "selected" }, box: { x: 1250, y: 0, w: 80, h: 30 } })]), SCREEN);
    expect(draft.elements).toHaveLength(0);
    expect(draft.rejectedElements).toBe(1);
  });
});

describe("disabled state", () => {
  const screen = { width: 100, height: 100 };
  const base = { label: "Siguiente", kind: "button", value: { state: "not_applicable" }, box: { x: 1, y: 1, w: 20, h: 10 }, visible: true };
  const reply = (extra: Record<string, unknown>[]): string => JSON.stringify({ elements: extra.map((e, i) => ({ id: `e${i + 1}`, ...base, ...e })), relations: [] });

  test("disabled is kept only when true; false and absent are the same", () => {
    const draft = mapPerceptionReply(reply([{ disabled: true }, { disabled: false }, {}]), screen);
    expect(draft.elements[0]).toMatchObject({ disabled: true });
    expect("disabled" in draft.elements[1]!).toBe(false);
    expect("disabled" in draft.elements[2]!).toBe(false);
  });

  test("a non-boolean disabled marks the element as rejected rather than guessed", () => {
    const draft = mapPerceptionReply(reply([{ disabled: "si" }]), screen);
    expect(draft.elements).toHaveLength(0);
    expect(draft.rejectedElements).toBe(1);
  });
});

describe("compact perception format (perception.v5)", () => {
  const screen = { width: 1280, height: 800 };
  const compact = JSON.stringify({
    elements: [
      { i: "e1", l: "Cliente", k: "label", b: [23, 108, 40, 12] },
      { i: "e2", l: "Cliente", k: "text_field", b: [23, 121, 150, 21], v: "Ana" },
      { i: "e3", l: "Notas", k: "text_field", b: [23, 160, 150, 21], s: "empty" },
      { i: "e4", l: "Teléfono", k: "text_field", b: [23, 190, 150, 21], s: "unknown" },
      { i: "e5", l: "Siguiente", k: "button", b: [164, 374, 88, 24], d: 1 },
      { i: "e6", l: "Guardar", k: "button", b: [10, 20, 80, 30] },
    ],
    relations: [["labels", "e1", "e2"]],
  });

  test("expands short keys, value states, disabled, and relations", () => {
    const draft = mapPerceptionReply(compact, screen);
    expect(draft.rejectedElements).toBe(0);
    expect(draft.elements).toEqual([
      { id: "e1", label: "Cliente", kind: "label", value: { state: "not_applicable" }, box: { x: 23, y: 108, w: 40, h: 12 }, visible: true },
      { id: "e2", label: "Cliente", kind: "text_field", value: { state: "text", text: "Ana" }, box: { x: 23, y: 121, w: 150, h: 21 }, visible: true },
      { id: "e3", label: "Notas", kind: "text_field", value: { state: "empty" }, box: { x: 23, y: 160, w: 150, h: 21 }, visible: true },
      { id: "e4", label: "Teléfono", kind: "text_field", value: { state: "unknown" }, box: { x: 23, y: 190, w: 150, h: 21 }, visible: true },
      { id: "e5", label: "Siguiente", kind: "button", value: { state: "not_applicable" }, box: { x: 164, y: 374, w: 88, h: 24 }, visible: true, disabled: true },
      { id: "e6", label: "Guardar", kind: "button", value: { state: "not_applicable" }, box: { x: 10, y: 20, w: 80, h: 30 }, visible: true },
    ]);
    expect(draft.relations).toEqual([{ kind: "labels", from: "e1", to: "e2" }]);
  });

  test("a compact element with a bad box or kind is rejected, never repaired into a guess", () => {
    const draft = mapPerceptionReply(
      JSON.stringify({ elements: [{ i: "e1", l: "A", k: "button", b: [1, 2, 3] }, { i: "e2", l: "B", k: "wizard", b: [1, 2, 3, 4] }, { i: "e3", l: "C", k: "button", b: [1, 2, 3, 4] }] }),
      screen,
    );
    expect(draft.elements.map((e) => e.id)).toEqual(["e3"]);
    expect(draft.rejectedElements).toBe(2);
  });

  test("an unreadable value state is repaired to unknown, as in the long form", () => {
    const draft = mapPerceptionReply(JSON.stringify({ elements: [{ i: "e1", l: "A", k: "text_field", b: [1, 2, 3, 4], s: "maybe" }] }), screen);
    expect(draft.elements[0]!.value).toEqual({ state: "unknown" });
  });

  test("the long form of perception.v3 and v4 still maps to the same elements", () => {
    const long = JSON.stringify({
      elements: [{ id: "e1", label: "Siguiente", kind: "button", value: { state: "not_applicable" }, box: { x: 164, y: 374, w: 88, h: 24 }, visible: true, disabled: true }],
      relations: [{ kind: "labels", from: "e1", to: "e1" }],
    });
    expect(mapPerceptionReply(long, screen).elements[0]).toMatchObject({ id: "e1", disabled: true });
  });

  test("the same screen costs about half as many characters as the long form", () => {
    const draft = mapPerceptionReply(compact, screen);
    const longForm = JSON.stringify({ elements: draft.elements, relations: draft.relations });
    expect(compact.length / longForm.length).toBeLessThan(0.65);
  });
});
