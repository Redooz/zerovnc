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

export function mapPerceptionReply(text: string, screen: ScreenSize): PerceptionDraft {
  const parsed = parseJson(text);
  const envelope = EnvelopeSchema.safeParse(parsed);
  if (!envelope.success) throw new ModelCallError("malformed", "perception reply has no elements list");

  // Ids that appear more than once are ambiguous: every copy is rejected.
  const idCounts = new Map<string, number>();
  for (const raw of envelope.data.elements) {
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
  for (const raw of envelope.data.elements) {
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
    const element = result.data;
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
  for (const raw of envelope.data.relations ?? []) {
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
