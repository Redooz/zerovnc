import { loadConfig, ConfigError } from "./config.ts";
import { createApp } from "./server.ts";
import { ConsoleLogger } from "../adapters/outbound/system/console-logger.ts";

const logger = new ConsoleLogger();

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.error("configuration rejected", { issues: error.issues.length });
      for (const issue of error.issues) console.error(`  - ${issue}`);
    } else {
      logger.error("configuration failed");
    }
    process.exit(1);
  }

  const app = createApp(config, { logger });
  await app.recoverInterruptedTasks();

  const server = Bun.serve({
    port: config.port,
    fetch: app.fetch,
  });
  logger.info("agent listening", { port: server.port ?? config.port });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { signal });
    // Stop accepting requests first, then cancel and drain tasks, then close the DB.
    await server.stop(true);
    await app.shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

await main();
