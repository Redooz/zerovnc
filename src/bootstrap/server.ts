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
import { DesktopOwnership } from "../application/desktop/desktop-ownership.ts";
import type { ArtifactStore } from "../application/ports/artifact-store.ts";
import type { DesktopSessionFactory } from "../application/ports/desktop-session.ts";
import { TraceRecorder } from "../application/trace/trace-recorder.ts";
import { FileArtifactStore } from "../adapters/outbound/artifacts/file-artifact-store.ts";
import { VncDesktopSessionFactory } from "../adapters/outbound/vnc/vnc-desktop-session.ts";
import { SqliteTraceRepository } from "../adapters/outbound/sqlite/sqlite-trace-repository.ts";

// Bounds on shutdown: lease holders get this long to release, and trace writes get
// this long to flush. Neither can hold up the process indefinitely.
export const SHUTDOWN_GRACE_MS = 3_000;
export const TRACE_FLUSH_MS = 2_000;
import { RandomIdGenerator } from "../adapters/outbound/system/random-id-generator.ts";
import { SystemClock } from "../adapters/outbound/system/system-clock.ts";
import { settledWithin } from "./bounded.ts";

export interface AppOverrides {
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly logger?: Logger;
  // Use ":memory:" in tests. Defaults to config.databasePath.
  readonly databasePath?: string;
  readonly desktopSessions?: DesktopSessionFactory;
  readonly artifacts?: ArtifactStore;
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

  const ownership = new DesktopOwnership(clock);
  const traceRecorder = new TraceRecorder(
    { repository: new SqliteTraceRepository(database), clock, ids, logger },
    [config.bearerToken],
  );
  const executeTask = new ExecuteTask({
    repository,
    clock,
    ids,
    ownership,
    sessions: overrides.desktopSessions ?? new VncDesktopSessionFactory(clock),
    trace: traceRecorder,
    artifacts: overrides.artifacts ?? new FileArtifactStore(config.artifactDir),
  });
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
      const started = Date.now();
      // Cancel running tasks first; each one releases its desktop before finishing.
      // A task that ignores cancellation must not hold shutdown past the grace period.
      const stopped = await settledWithin(scheduler.stop(), SHUTDOWN_GRACE_MS);
      if (!stopped) logger.error("tasks still running at shutdown", {});
      const remaining = SHUTDOWN_GRACE_MS - (Date.now() - started);
      const drained = await ownership.close(Math.max(0, remaining));
      if (!drained) logger.error("desktop leases still held at shutdown", {});
      const flushed = await traceRecorder.flush(TRACE_FLUSH_MS);
      if (!flushed) logger.error("trace events still pending at shutdown", {});
      database.close();
    },
  };
}
