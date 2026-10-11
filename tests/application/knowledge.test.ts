import { describe, expect, test } from "bun:test";
import { appKeyOf, renderNotes, renderSteps, screenKeyOf } from "../../src/application/knowledge/knowledge.ts";
import type { KnowledgeNote } from "../../src/application/ports/knowledge-repository.ts";
import type { Observation } from "../../src/domain/perception/observation.ts";

function observationOf(elements: Array<{ id: string; kind: string; label: string; value?: Observation["elements"][number]["value"] }>): Observation {
  return {
    id: "obs-1",
    taskId: "t",
    capturedAt: new Date(0),
    width: 100,
    height: 100,
    frameRevision: 1,
    screenshotRef: null,
    elements: elements.map((element) => ({
      id: element.id,
      kind: element.kind as Observation["elements"][number]["kind"],
      label: element.label,
      value: element.value ?? { state: "not_applicable" },
      box: { x: 0, y: 0, w: 10, h: 10 },
      visible: true,
    })),
    relations: [],
  };
}

const note = (screenKey: string, steps: string[]): KnowledgeNote => ({ appKey: "a", screenKey, steps, createdAt: new Date(0) });

describe("fingerprints", () => {
  test("the app key never contains the URL, and the same URL gives the same key", () => {
    const key = appKeyOf("wss://desktop.example/websockify?token=secret");
    expect(key).not.toContain("desktop.example");
    expect(key).not.toContain("secret");
    expect(key).toHaveLength(32);
    expect(appKeyOf("wss://desktop.example/websockify?token=secret")).toBe(key);
    expect(appKeyOf("wss://other.example/websockify")).not.toBe(key);
  });

  test("the screen key depends on structure, not on values or order", () => {
    const a = screenKeyOf(observationOf([{ id: "1", kind: "button", label: "Guardar" }, { id: "2", kind: "text_field", label: "Nombre" }]));
    const b = screenKeyOf(observationOf([{ id: "2", kind: "text_field", label: "Nombre", value: { state: "text", text: "Ana" } }, { id: "1", kind: "button", label: "Guardar" }]));
    expect(b).toBe(a);
    const different = screenKeyOf(observationOf([{ id: "1", kind: "button", label: "Guardar" }, { id: "3", kind: "button", label: "Limpiar" }]));
    expect(different).not.toBe(a);
  });

  test("steps render as an ordered, value-free list", () => {
    expect(renderSteps(['clicked "Clientes"', 'filled in "Nombre"'])).toBe('clicked "Clientes"; filled in "Nombre"');
  });
});

describe("advisory notes", () => {
  test("nothing is offered without a starting screen", () => {
    expect(renderNotes([note("k", ['clicked "Clientes"'])], null)).toBeNull();
  });

  test("only notes from the same starting screen are offered, capped at two", () => {
    const notes = [note("other", ['clicked "Ventas"']), note("here", ['clicked "Clientes"']), note("here", ['clicked "Facturas"']), note("here", ['clicked "Pedidos"'])];
    const rendered = renderNotes(notes, "here");
    expect(rendered?.count).toBe(2);
    expect(rendered?.text).toContain('clicked "Clientes"');
    expect(rendered?.text).not.toContain("Ventas");
    expect(rendered?.text).not.toContain("Pedidos");
  });

  test("the wording marks them as suggestions that must be re-checked", () => {
    const rendered = renderNotes([note("here", ['clicked "Clientes"'])], "here");
    expect(rendered?.text).toContain("Suggestions only");
    expect(rendered?.text).toContain("re-check each step");
  });

  test("an empty or unrelated set produces no section, so no tokens are spent", () => {
    expect(renderNotes([], "here")).toBeNull();
    expect(renderNotes([note("elsewhere", ['clicked "X"'])], "here")).toBeNull();
  });
});