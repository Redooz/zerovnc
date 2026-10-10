import { describe, expect, test } from "bun:test";
import { createObservation, findElement, ObservationError, type ObservedElement } from "../../src/domain/perception/observation.ts";

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const el = (id: string, overrides: Partial<ObservedElement> = {}): ObservedElement => ({
  id,
  label: "Guardar",
  kind: "button",
  value: { state: "not_applicable" },
  box: box(10, 10, 80, 30),
  visible: true,
  ...overrides,
});
const base = {
  id: "obs-1",
  taskId: "task-1",
  capturedAt: new Date(0),
  width: 1280,
  height: 800,
  frameRevision: 3,
  screenshotRef: null,
  elements: [el("e1")],
  relations: [],
};

describe("observation contract", () => {
  test("accepts a grounded observation and finds elements by scoped id", () => {
    const observation = createObservation(base);
    expect(findElement(observation, "e1")?.label).toBe("Guardar");
    expect(findElement(observation, "missing")).toBeUndefined();
  });

  test("rejects duplicate element ids", () => {
    expect(() => createObservation({ ...base, elements: [el("e1"), el("e1")] })).toThrow(ObservationError);
  });

  test("rejects visible boxes outside the screen", () => {
    expect(() => createObservation({ ...base, elements: [el("e1", { box: box(1250, 10, 80, 30) })] })).toThrow(/outside the screen/);
  });

  test("allows hidden elements outside the visible area", () => {
    const hidden = el("e2", { visible: false, box: box(1250, 790, 80, 30) });
    expect(() => createObservation({ ...base, elements: [hidden] })).not.toThrow();
  });

  test("rejects non-integer and empty boxes", () => {
    expect(() => createObservation({ ...base, elements: [el("e1", { box: box(1.5, 10, 80, 30) })] })).toThrow(/integer/);
    expect(() => createObservation({ ...base, elements: [el("e1", { box: box(10, 10, 0, 30) })] })).toThrow(/positive size/);
  });

  test("rejects relations to unknown or identical elements", () => {
    expect(() => createObservation({ ...base, relations: [{ kind: "labels", from: "e1", to: "e9" }] })).toThrow(/unknown element/);
    expect(() => createObservation({ ...base, relations: [{ kind: "labels", from: "e1", to: "e1" }] })).toThrow(/itself/);
  });

  test("reports every issue at once", () => {
    try {
      createObservation({ ...base, width: 0, elements: [el("bad id!"), el("e2", { box: box(-1, 0, 5, 5) })] });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ObservationError);
      expect((error as ObservationError).issues.length).toBeGreaterThanOrEqual(3);
    }
  });

  test("unknown values are kept as unknown, never as empty text", () => {
    const observation = createObservation({ ...base, elements: [el("e1", { kind: "text_field", value: { state: "unknown" } })] });
    expect(findElement(observation, "e1")?.value).toEqual({ state: "unknown" });
  });
});
