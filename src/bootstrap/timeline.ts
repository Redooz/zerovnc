// Prints the trace of one task: bun run timeline <task-id>
import { loadConfig, ConfigError } from "./config.ts";
import { openDatabase } from "../adapters/outbound/sqlite/database.ts";
import { SqliteTraceRepository } from "../adapters/outbound/sqlite/sqlite-trace-repository.ts";
import { formatTimeline } from "../application/trace/format-timeline.ts";

const taskId = process.argv[2];
if (!taskId) {
  console.error("usage: bun run timeline <task-id>");
  process.exit(2);
}

let databasePath: string;
try {
  databasePath = loadConfig().databasePath;
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`configuration rejected: ${error.issues.map((issue) => issue.split(":")[0]).join(", ")}`);
  }
  process.exit(1);
}

const database = openDatabase(databasePath);
const events = await new SqliteTraceRepository(database).forTask(taskId);
database.close();
if (events.length === 0) {
  console.error(`no trace events for task ${taskId}`);
  process.exit(1);
}
for (const line of formatTimeline(events)) console.log(line);
