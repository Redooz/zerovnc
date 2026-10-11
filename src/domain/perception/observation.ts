// Observation contract for one captured screen. An observation is the only
// evidence later decisions may cite: element identifiers are scoped to one
// observation, and every box, relation, and value must be checkable here.
import type { TaskId } from "../tasks/task.ts";

export const CONTROL_KINDS = [
  "button",
  "link",
  "tab",
  "menu_item",
  "text_field",
  "checkbox",
  "dropdown",
  "date_field",
  "icon_button",
  "table_header",
  "table_cell",
  "table_row",
  "label",
  "dialog",
  "message",
  "text",
  "other",
] as const;
export type ControlKind = (typeof CONTROL_KINDS)[number];

// Pixels, integers, origin at the top-left of the screenshot.
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

// "unknown" means the content exists but could not be read. It is never a guess.
export type ElementValue =
  | { readonly state: "text"; readonly text: string }
  | { readonly state: "empty" }
  | { readonly state: "not_applicable" }
  | { readonly state: "unknown" };

// A numbered candidate box drawn on a screenshot so a model can answer by number.
export interface NumberedBox {
  readonly number: number;
  readonly box: Box;
}

export interface ObservedElement {
  readonly id: string;
  readonly label: string;
  readonly kind: ControlKind;
  readonly value: ElementValue;
  readonly box: Box;
  readonly visible: boolean;
  // True only when the control is visibly greyed out or inactive. Absent means not disabled.
  readonly disabled?: boolean;
}

// "labels": `from` is a label that names field `to`.
// "header_of": `from` is a column header that applies to `to` (a cell or row).
export interface ElementRelation {
  readonly kind: "labels" | "header_of";
  readonly from: string;
  readonly to: string;
}

export interface Observation {
  readonly id: string;
  readonly taskId: TaskId;
  readonly capturedAt: Date;
  readonly width: number;
  readonly height: number;
  readonly frameRevision: number;
  readonly screenshotRef: string | null;
  readonly elements: readonly ObservedElement[];
  readonly relations: readonly ElementRelation[];
}

export class ObservationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid observation: ${issues.join("; ")}`);
    this.name = "ObservationError";
  }
}

const ELEMENT_ID = /^[A-Za-z0-9_-]{1,40}$/;
export const MAX_LABEL_LENGTH = 300;
export const MAX_VALUE_LENGTH = 2_000;

// Returns every problem found, so a rejected observation explains all of them at once.
export interface ObservationShape {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly frameRevision: number;
  readonly elements: readonly ObservedElement[];
  readonly relations: readonly ElementRelation[];
}

export function observationIssues(input: ObservationShape): string[] {
  const issues: string[] = [];
  if (input.id.trim() === "") issues.push("observation id is required");
  if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width <= 0 || input.height <= 0) {
    issues.push("dimensions must be positive integers");
  }
  if (!Number.isInteger(input.frameRevision) || input.frameRevision < 0) {
    issues.push("frame revision must be a non-negative integer");
  }

  const ids = new Set<string>();
  for (const element of input.elements) {
    const where = `element ${JSON.stringify(element.id)}`;
    if (!ELEMENT_ID.test(element.id)) {
      issues.push(`${where}: id must be 1-40 letters, digits, '_' or '-'`);
    } else if (ids.has(element.id)) {
      issues.push(`${where}: duplicate id`);
    }
    ids.add(element.id);
    if (element.label.length > MAX_LABEL_LENGTH) issues.push(`${where}: label too long`);
    if (element.value.state === "text") {
      if (element.value.text.length > MAX_VALUE_LENGTH) issues.push(`${where}: value too long`);
    }
    issues.push(...boxIssues(where, element.box, input.width, input.height, element.visible));
  }

  for (const relation of input.relations) {
    const where = `relation ${relation.kind} ${JSON.stringify(relation.from)}->${JSON.stringify(relation.to)}`;
    if (!ids.has(relation.from) || !ids.has(relation.to)) {
      issues.push(`${where}: refers to an unknown element`);
    } else if (relation.from === relation.to) {
      issues.push(`${where}: an element cannot relate to itself`);
    }
  }
  return issues;
}

function boxIssues(where: string, box: Box, width: number, height: number, visible: boolean): string[] {
  const issues: string[] = [];
  const integers = [box.x, box.y, box.w, box.h].every((n) => Number.isInteger(n));
  if (!integers) {
    issues.push(`${where}: box must use integer pixels`);
    return issues;
  }
  if (box.w < 1 || box.h < 1) issues.push(`${where}: box must have positive size`);
  if (box.x < 0 || box.y < 0) issues.push(`${where}: box starts outside the screen`);
  // Off-screen elements (scrolled away) may legitimately lie outside the screen,
  // but a visible element must be fully inside the screenshot to be clickable evidence.
  if (visible && (box.x + box.w > width || box.y + box.h > height)) {
    issues.push(`${where}: visible box extends outside the screen`);
  }
  return issues;
}

export function createObservation(input: Observation): Observation {
  const issues = observationIssues(input);
  if (issues.length > 0) throw new ObservationError(issues);
  return Object.freeze({
    ...input,
    capturedAt: new Date(input.capturedAt.getTime()),
    elements: Object.freeze(input.elements.map((element) => Object.freeze({ ...element }))),
    relations: Object.freeze(input.relations.map((relation) => Object.freeze({ ...relation }))),
  });
}

export function findElement(observation: Observation, id: string): ObservedElement | undefined {
  return observation.elements.find((element) => element.id === id);
}
