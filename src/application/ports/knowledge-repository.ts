// Store of procedures verified on one application, so a later task on the same screen can be
// planned faster. Notes are advisory: every step still goes through a tool that grounds it on a
// fresh observation. A note never carries record data (no typed values, no identities) and is
// bound to one app and one starting screen.
import type { TaskId } from "../../domain/tasks/task.ts";

// One verified path, as UI targets only: `clicked "Clientes"`, `replaced "Nombre"`.
export interface KnowledgeNote {
  readonly appKey: string;
  // Fingerprint of the screen the task started from; a note is only offered on that screen.
  readonly screenKey: string;
  // Ordered UI targets, already reduced to labels without values.
  readonly steps: readonly string[];
  readonly createdAt: Date;
}

export interface SaveNoteInput {
  readonly appKey: string;
  readonly screenKey: string;
  readonly steps: readonly string[];
  readonly taskId: TaskId;
}

// Newest first, aged out by the adapter. `limit` is a safety bound on prompt size. The caller
// decides which screen keys apply.
export interface KnowledgeRepository {
  save(input: SaveNoteInput): Promise<void>;
  forApp(appKey: string, limit: number): Promise<readonly KnowledgeNote[]>;
}