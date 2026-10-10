// Composition root: builds adapters, injects them into use cases, and returns
// the HTTP handler. The only place that knows concrete adapter classes.
import type { Database } from "bun:sqlite";
import type { AppConfig } from "./config.ts";
import { ExecuteTask } from "../application/usecases/execute-task.ts";
import { FailInterruptedTasks } from "../application/usecases/fail-interrupted-tasks.ts";
import { GetTask } from "../application/usecases/get-task.ts";
import { SubmitTask } from "../application/usecases/submit-task.ts";
import { GetTaskHandler, SubmitTaskHandler } from "../application/handlers/task-handlers.ts";
import type { Clock } from "../application/ports/clock.ts";
import type { IdGenerator } from "../application/ports/id-generator.ts";
import type { Logger } from "../application/ports/logger.ts";
import { createRouter } from "../adapters/inbound/http/router.ts";
import { InProcessTaskScheduler } from "../adapters/inbound/worker/in-process-task-scheduler.ts";
import { openDatabase } from "../adapters/outbound/sqlite/database.ts";
import { SqliteTaskRepository } from "../adapters/outbound/sqlite/sqlite-task-repository.ts";
import { ConsoleLogger } from "../adapters/outbound/system/console-logger.ts";
import { RandomIdGenerator } from "../adapters/outbound/system/random-id-generator.ts";
import { SystemClock } from "../adapters/outbound/system/system-clock.ts";

export interface AppOverrides {
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly logger?: Logger;
  // Use ":memory:" in tests. Defaults to config.databasePath.
  readonly databasePath?: string;
}

export interface App {
  readonly fetch: (request: Request) => Promise<Response>;
  // Marks tasks left `en_curso` by a previous process as `fallida`.
  recoverInterruptedTasks(): Promise<number>;
  // Cancels running tasks, waits for them, and closes the database.
  shutdown(): Promise<void>;
  readonly database: Database;
}

export function createApp(config: AppConfig, overrides: AppOverrides = {}): App {
  const logger = overrides.logger ?? new ConsoleLogger();
  const clock = overrides.clock ?? new SystemClock();
  const ids = overrides.ids ?? new RandomIdGenerator();

  const database = openDatabase(overrides.databasePath ?? config.databasePath);
  const repository = new SqliteTaskRepository(database);

  const executeTask = new ExecuteTask({ repository, clock });
  const scheduler = new InProcessTaskScheduler({
    logger,
    run: (job, signal) => executeTask.execute({ taskId: job.taskId, desktop: job.desktop, signal }),
  });

  const submitTask = new SubmitTask({
    repository,
    scheduler,
    clock,
    ids,
    timeoutMs: config.taskTimeoutMs,
  });
  const getTask = new GetTask(repository);
  const failInterrupted = new FailInterruptedTasks({ repository, clock });

  const fetch = createRouter({
    bearerToken: config.bearerToken,
    submitTask: new SubmitTaskHandler(submitTask),
    getTask: new GetTaskHandler(getTask),
    logger,
  });

  let closed = false;
  return {
    fetch,
    database,
    recoverInterruptedTasks: async () => {
      const count = await failInterrupted.execute();
      if (count > 0) {
        logger.info("recovered interrupted tasks", { count });
      }
      return count;
    },
    shutdown: async () => {
      if (closed) return;
      closed = true;
      await scheduler.stop();
      database.close();
    },
  };
}
