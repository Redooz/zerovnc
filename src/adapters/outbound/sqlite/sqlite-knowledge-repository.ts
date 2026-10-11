import type { Database } from "bun:sqlite";
import type { KnowledgeNote, KnowledgeRepository, SaveNoteInput } from "../../../application/ports/knowledge-repository.ts";

// Caps that bound prompt size and the table itself. Notes older than the window are not offered:
// a saved procedure describes an app that has since changed.
export const MAX_NOTES_PER_APP = 5;
export const NOTE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_STEPS_PER_NOTE = 12;
export const MAX_NOTE_CHARS = 400;

// Stores verified procedures per app and starting screen. Steps are a JSON array of UI target
// labels; nothing else is kept, so a note cannot carry record data.
export class SqliteKnowledgeRepository implements KnowledgeRepository {
  constructor(
    private readonly db: Database,
    private readonly options: { readonly maxPerApp?: number; readonly ttlMs?: number } = {},
  ) {}

  async save(input: SaveNoteInput): Promise<void> {
    const steps = input.steps.map((step) => step.slice(0, 80)).slice(0, MAX_STEPS_PER_NOTE);
    if (steps.length === 0) return;
    const json = JSON.stringify(steps);
    if (json.length > MAX_NOTE_CHARS) return;
    const now = new Date();
    this.db
      .query(
        `INSERT INTO knowledge_notes (app_key, screen_key, steps, task_id, created_at)
         VALUES ($app_key, $screen_key, $steps, $task_id, $created_at)`,
      )
      .run({
        app_key: input.appKey,
        screen_key: input.screenKey,
        steps: json,
        task_id: input.taskId,
        created_at: now.toISOString(),
      });
    this.prune(input.appKey);
  }

  // Newest first, notes older than the window dropped, at most `limit` returned.
  async forApp(appKey: string, limit: number): Promise<readonly KnowledgeNote[]> {
    const rows = this.db
      .query<{ screen_key: string; steps: string; created_at: string }, [string]>(
        "SELECT screen_key, steps, created_at FROM knowledge_notes WHERE app_key = ? ORDER BY created_at DESC, id DESC",
      )
      .all(appKey);
    const ttl = this.options.ttlMs ?? NOTE_TTL_MS;
    const now = Date.now();
    const notes: KnowledgeNote[] = [];
    const bound = Math.max(0, limit);
    for (const row of rows) {
      if (notes.length >= bound) break;
      // `>=` so a window of zero expires a note written in the same millisecond.
      if (now - new Date(row.created_at).getTime() >= ttl) continue;
      notes.push({ appKey, screenKey: row.screen_key, steps: JSON.parse(row.steps) as string[], createdAt: new Date(row.created_at) });
    }
    return notes;
  }

  // Keeps the newest notes per app. Idempotent, cheap, and only runs when a note is written.
  private prune(appKey: string): void {
    const max = this.options.maxPerApp ?? MAX_NOTES_PER_APP;
    this.db
      .query(
        `DELETE FROM knowledge_notes
         WHERE app_key = $app_key
           AND id NOT IN (SELECT id FROM knowledge_notes WHERE app_key = $app_key ORDER BY created_at DESC, id DESC LIMIT $max)`,
      )
      .run({ app_key: appKey, max });
  }
}