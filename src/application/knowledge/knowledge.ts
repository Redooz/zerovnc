// Turning a finished task into a note a later task can read, and turning notes back into prompt
// text. Three rules make this safe: only a verified (`terminada`) task writes, a note holds UI
// target labels only (never typed values or record identities), and a note is only offered on the
// screen it was verified from.
import { createHash } from "node:crypto";
import type { KnowledgeNote } from "../ports/knowledge-repository.ts";
import type { Observation } from "../../domain/perception/observation.ts";

// The desktop URL is hashed, never stored: it can embed a token.
export function appKeyOf(desktopUrl: string): string {
  return createHash("sha256").update("app|").update(desktopUrl).digest("hex").slice(0, 32);
}

// Fingerprint of the screen's structure: kinds and labels only, values excluded, so two screens
// with the same controls match even when the data on them differs.
export function screenKeyOf(observation: Observation): string {
  const shape = observation.elements
    .filter((element) => element.visible)
    .map((element) => `${element.kind}|${element.label.trim()}`)
    .sort()
    .join("\n");
  return createHash("sha256").update("screen|").update(shape).digest("hex").slice(0, 32);
}

// A note's text: what was clicked or filled in, in order, without values.
export function renderSteps(steps: readonly string[]): string {
  return steps.join("; ");
}

export interface RenderedNotes {
  readonly text: string;
  readonly count: number;
}

const MAX_NOTES_IN_PROMPT = 2;

// Advisory section for the planner, or null when nothing applies. Never instructs: the planner
// still grounds every step on a fresh observation.
export function renderNotes(notes: readonly KnowledgeNote[], screenKey: string | null): RenderedNotes | null {
  if (screenKey === null) return null;
  const applicable = notes.filter((note) => note.screenKey === screenKey).slice(0, MAX_NOTES_IN_PROMPT);
  if (applicable.length === 0) return null;
  const lines = [
    "Previously verified on this app from this screen. Suggestions only: re-check each step against the current screen, and ignore any that does not fit this task.",
  ];
  for (const [index, note] of applicable.entries()) {
    lines.push(`${index + 1}. ${renderSteps(note.steps)}`);
  }
  return { text: lines.join("\n"), count: applicable.length };
}