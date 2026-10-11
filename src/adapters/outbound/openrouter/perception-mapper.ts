// Maps raw perception model text to domain elements. Lives beside the adapter:
// provider wording never leaks into the domain. Malformed envelopes fail the
// whole reply; individual elements that cannot be grounded are dropped and counted.
import { z } from "zod";
import { ModelCallError } from "../../../application/ports/model-call-error.ts";
import type { PerceptionDraft } from "../../../application/ports/perception-model.ts";
import { CONTROL_KINDS, observationIssues, type ElementRelation, type ObservedElement } from "../../../domain/perception/observation.ts";
import { stripJsonFence } from "./json-text.ts";

const BoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});

const ValueSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("text"), text: z.string() }),
  z.object({ state: z.literal("empty") }),
  z.object({ state: z.literal("not_applicable") }),
  z.object({ state: z.literal("unknown") }),
]);

const ElementSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(CONTROL_KINDS),
  value: ValueSchema,
  box: BoxSchema,
  visible: z.boolean(),
  disabled: z.boolean().optional(),
});

const RelationSchema = z.object({
  kind: z.enum(["labels", "header_of"]),
  from: z.string(),
  to: z.string(),
});

const EnvelopeSchema = z.object({
  elements: z.array(z.unknown()),
  relations: z.array(z.unknown()).optional().default([]),
});

const MAX_REJECTION_NOTES = 10;

export interface ScreenSize {
  readonly width: number;
  readonly height: number;
}

// Compact element form (perception.v5): short keys, defaults omitted.
//   i id, l label, k kind, b [x,y,w,h], v text value, s "empty" | "unknown", d 1 disabled, h 1 hidden.
// Anything that is not recognizable as compact is returned unchanged, so the long form (perception.v3
// and v4) still maps, and a malformed compact element fails the same schema checks as any other.
export function expandCompactElement(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const e = raw as Record<string, unknown>;
  if (!("k" in e) && !("b" in e)) return raw;
  if ("kind" in e || "box" in e) return raw;
  const b = e.b;
  const box = Array.isArray(b) && b.length === 4 ? { x: b[0], y: b[1], w: b[2], h: b[3] } : undefined;
  let value: unknown = { state: "not_applicable" };
  if (typeof e.v === "string") value = { state: "text", text: e.v };
  else if (e.s === "empty" || e.s === "unknown") value = { state: e.s };
  else if (e.v !== undefined || e.s !== undefined) value = { state: "invalid" };
  return {
    id: e.i,
    label: e.l ?? "",
    kind: e.k,
    value,
    box,
    visible: e.h === 1 || e.h === true ? false : true,
    ...(e.d === 1 || e.d === true ? { disabled: true } : {}),
  };
}

function expandCompactRelation(raw: unknown): unknown {
  return Array.isArray(raw) && raw.length === 3 ? { kind: raw[0], from: raw[1], to: raw[2] } : raw;
}

export function mapPerceptionReply(text: string, screen: ScreenSize): PerceptionDraft {
  const parsed = parseJson(text);
  const envelope = EnvelopeSchema.safeParse(parsed);
  if (!envelope.success) throw new ModelCallError("malformed", "perception reply has no elements list");
  const elementsRaw = envelope.data.elements.map(expandCompactElement);
  const relationsRaw = (envelope.data.relations ?? []).map(expandCompactRelation);

  // Ids that appear more than once are ambiguous: every copy is rejected.
  const idCounts = new Map<string, number>();
  for (const raw of elementsRaw) {
    const id = typeof raw === "object" && raw !== null && typeof (raw as { id?: unknown }).id === "string"
      ? (raw as { id: string }).id
      : null;
    if (id !== null) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  }

  const elements: ObservedElement[] = [];
  const rejections: string[] = [];
  let rejected = 0;
  const reject = (who: string, why: string): void => {
    rejected += 1;
    if (rejections.length < MAX_REJECTION_NOTES) rejections.push(`${who}: ${why}`);
  };
  for (const raw of elementsRaw) {
    let result = ElementSchema.safeParse(raw);
    // An element whose only defect is its value keeps its label and box; the value is
    // recorded as unknown (never invented) and the repair is noted.
    if (!result.success && result.error.issues.every((issue) => issue.path[0] === "value") && typeof raw === "object" && raw !== null) {
      const repaired = ElementSchema.safeParse({ ...(raw as Record<string, unknown>), value: { state: "unknown" } });
      if (repaired.success) {
        result = repaired;
        if (rejections.length < MAX_REJECTION_NOTES) rejections.push(`${repaired.data.id}: value repaired to unknown (invalid value state)`);
      }
    }
    const who = typeof raw === "object" && raw !== null && typeof (raw as { id?: unknown }).id === "string" ? (raw as { id: string }).id : "(no id)";
    if (!result.success) {
      const issue = result.error.issues[0];
      reject(who, `schema ${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`.trim());
      continue;
    }
    // `disabled` is kept only when true; false and absent mean the same thing.
    const { disabled, ...rest } = result.data;
    const element: ObservedElement = disabled === true ? { ...rest, disabled: true } : rest;
    if ((idCounts.get(element.id) ?? 0) > 1) {
      reject(element.id, "duplicate id");
      continue;
    }
    // Check the element alone against the observation contract (bounds, id shape, sizes).
    const issues = observationIssues({
      id: "probe",
      width: screen.width,
      height: screen.height,
      frameRevision: 0,
      elements: [element],
      relations: [],
    });
    if (issues.length > 0) {
      reject(element.id, issues.join("; "));
      continue;
    }
    elements.push(element);
  }

  // Relations are kept only when both ends survived; dangling relations are dropped.
  const kept = new Set(elements.map((element) => element.id));
  const relations: ElementRelation[] = [];
  for (const raw of relationsRaw) {
    const result = RelationSchema.safeParse(raw);
    if (result.success && result.data.from !== result.data.to && kept.has(result.data.from) && kept.has(result.data.to)) {
      relations.push(result.data);
    }
  }

  return { elements, relations, rejectedElements: rejected, rejections };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(stripJsonFence(text));
  } catch {
    throw new ModelCallError("malformed", "perception reply is not JSON");
  }
}
