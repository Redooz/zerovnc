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
];
