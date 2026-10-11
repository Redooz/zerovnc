// Ordered, append-only schema migrations. Never edit an applied migration;
// add a new version instead.
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "create_tasks",
    sql: `
      CREATE TABLE tasks (
        id          TEXT PRIMARY KEY NOT NULL,
        instruction TEXT NOT NULL,
        status      TEXT NOT NULL CHECK (status IN ('en_curso', 'terminada', 'fallida')),
        summary     TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        finished_at TEXT NULL,
        deadline_at TEXT NOT NULL
      );
      CREATE INDEX tasks_status_idx ON tasks (status);
    `,
  },
  {
    version: 2,
    name: "create_trace_events",
    sql: `
      CREATE TABLE trace_events (
        seq            INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id        TEXT NOT NULL,
        span_id        TEXT NOT NULL,
        parent_span_id TEXT NULL,
        kind           TEXT NOT NULL,
        at             TEXT NOT NULL,
        payload        TEXT NOT NULL
      );
      CREATE INDEX trace_events_task_idx ON trace_events (task_id, seq);
    `,
  },
  {
    version: 3,
    name: "create_knowledge_notes",
    sql: `
      CREATE TABLE knowledge_notes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        app_key     TEXT NOT NULL,
        screen_key  TEXT NOT NULL,
        steps       TEXT NOT NULL,
        task_id     TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX knowledge_notes_app_idx ON knowledge_notes (app_key, screen_key, created_at);
    `,
  },
];
