// Provider-neutral planner transcript and its compaction. The planner adapter maps these
// entries to and from its SDK messages. Compaction is deterministic and calls no model,
// so it cannot exceed the task deadline. It runs before every planning cycle.
import type { ToolStatus } from "../tools/contract.ts";

export interface ToolCallRecord {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export type TranscriptEntry =
  // Instructions (pinned) and per-cycle state snapshots.
  | { readonly kind: "user"; readonly text: string; readonly pinned?: boolean }
  // Planner text and tool requests of one model turn.
  | { readonly kind: "assistant"; readonly text: string; readonly toolCalls: readonly ToolCallRecord[] }
  | { readonly kind: "tool_result"; readonly toolCallId: string; readonly toolName: string; readonly status: ToolStatus; readonly text: string };

export interface CompactionOptions {
  // Character budget for the whole transcript (a rough proxy for the context window).
  readonly budgetChars: number;
  // Newest entries that are never compacted.
  readonly keepRecent: number;
}

export interface CompactionReport {
  readonly beforeChars: number;
  readonly afterChars: number;
  // Entries shortened in place.
  readonly shortened: number;
  // Entries removed; replaced by one note entry.
  readonly omitted: number;
}

// Tool results that carry verified progress or constraints keep more text.
const KEEP_FULL_TOOLS = new Set(["set_plan", "verify_result", "report_blocker"]);
const KEEP_LONG = 600;
const KEEP_SHORT = 160;
const ASSISTANT_KEEP = 300;
const STATE_KEEP = 200;
const NOTE_RESERVE_CHARS = 200;

export const DEFAULT_COMPACTION: CompactionOptions = { budgetChars: 160_000, keepRecent: 8 };

export function transcriptChars(entries: readonly TranscriptEntry[]): number {
  let total = 0;
  for (const entry of entries) {
    if (entry.kind === "user" || entry.kind === "assistant") {
      total += entry.text.length;
      if (entry.kind === "assistant") total += JSON.stringify(entry.toolCalls).length;
    } else {
      total += entry.text.length + entry.toolName.length;
    }
  }
  return total;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 3)}...`;
}

function shorten(entry: TranscriptEntry): TranscriptEntry {
  switch (entry.kind) {
    case "user":
      return { kind: "user", text: `[earlier state, compacted] ${clip(entry.text, STATE_KEEP)}` };
    case "assistant":
      return { kind: "assistant", text: clip(entry.text, ASSISTANT_KEEP), toolCalls: entry.toolCalls };
    case "tool_result": {
      const max = KEEP_FULL_TOOLS.has(entry.toolName) ? KEEP_LONG : KEEP_SHORT;
      return { ...entry, text: clip(entry.text, max) };
    }
  }
}

// A unit is the smallest group that can be removed without breaking the transcript:
// an assistant turn together with its tool results, or any other single entry.
function units(entries: readonly TranscriptEntry[]): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < entries.length) {
    const entry = entries[i]!;
    let end = i + 1;
    if (entry.kind === "assistant") {
      while (end < entries.length && entries[end]!.kind === "tool_result") end++;
    }
    out.push({ start: i, end });
    i = end;
  }
  return out;
}

// Keeps pinned entries and the newest `keepRecent` entries intact. Older entries are shortened
// first. If the transcript is still over budget, the oldest whole units are removed and replaced
// by one note, so tool requests never lose their results.
export function compactTranscript(entries: readonly TranscriptEntry[], options: CompactionOptions = DEFAULT_COMPACTION): {
  readonly entries: TranscriptEntry[];
  readonly report: CompactionReport;
} {
  const beforeChars = transcriptChars(entries);
  if (beforeChars <= options.budgetChars) {
    return { entries: [...entries], report: { beforeChars, afterChars: beforeChars, shortened: 0, omitted: 0 } };
  }

  const protectedFrom = Math.max(0, entries.length - options.keepRecent);
  let shortened = 0;
  let working: TranscriptEntry[] = entries.map((entry, index) => {
    if (index >= protectedFrom || (entry.kind === "user" && entry.pinned)) return entry;
    const next = shorten(entry);
    if (transcriptChars([next]) < transcriptChars([entry])) shortened++;
    return next;
  });

  let omitted = 0;
  if (transcriptChars(working) > options.budgetChars) {
    const drop = new Set<number>();
    let chars = transcriptChars(working);
    // Room for the note that replaces the removed entries, so the result still fits.
    const target = options.budgetChars - NOTE_RESERVE_CHARS;
    // Oldest removable units go first. Pinned entries and the protected tail are skipped.
    for (const unit of units(working)) {
      if (chars <= target) break;
      const first = working[unit.start]!;
      if (unit.start >= protectedFrom || (first.kind === "user" && first.pinned)) continue;
      chars -= transcriptChars(working.slice(unit.start, unit.end));
      for (let i = unit.start; i < unit.end; i++) drop.add(i);
      omitted += unit.end - unit.start;
    }
    if (drop.size > 0) {
      const firstDropped = Math.min(...drop);
      const note: TranscriptEntry = { kind: "user", text: `[${omitted} earlier entries omitted to fit the context budget]` };
      const out: TranscriptEntry[] = [];
      working.forEach((entry, index) => {
        if (index === firstDropped) out.push(note);
        if (!drop.has(index)) out.push(entry);
      });
      working = out;
    }
  }

  const afterChars = transcriptChars(working);
  return { entries: working, report: { beforeChars, afterChars, shortened, omitted } };
}
