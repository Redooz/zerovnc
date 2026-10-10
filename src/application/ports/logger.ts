// Logging port. Callers must pass identifiers and statuses only, never task
// instructions, desktop URLs, or passwords.
export interface Logger {
  info(message: string, fields?: Readonly<Record<string, string | number>>): void;
  error(message: string, fields?: Readonly<Record<string, string | number>>): void;
}
