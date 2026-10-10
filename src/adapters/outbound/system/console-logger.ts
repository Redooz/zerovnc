import type { Logger } from "../../../application/ports/logger.ts";

type Fields = Readonly<Record<string, string | number>>;

// One JSON line per event. Fields are caller-controlled and must stay free of secrets.
export class ConsoleLogger implements Logger {
  info(message: string, fields: Fields = {}): void {
    console.log(JSON.stringify({ level: "info", message, ...fields, at: new Date().toISOString() }));
  }

  error(message: string, fields: Fields = {}): void {
    console.error(JSON.stringify({ level: "error", message, ...fields, at: new Date().toISOString() }));
  }
}
