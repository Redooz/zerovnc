import { ScriptedPlanner, stubModels } from "../support/agent-doubles.ts";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/adapters/outbound/sqlite/database.ts";
import { createApp, SHUTDOWN_GRACE_MS, TRACE_FLUSH_MS, type App } from "../../src/bootstrap/server.ts";
import type { AppConfig } from "../../src/bootstrap/config.ts";
import type { Logger } from "../../src/application/ports/logger.ts";
import type { Clock } from "../../src/application/ports/clock.ts";
import { CANCELLED_SUMMARY } from "../../src/application/usecases/execute-task.ts";

const TOKEN = "test-token-0123456789abcdef";
const DESKTOP = { url: "wss://escritorio.example/websockify", password: "clave-shutdown-42" };
const BASE = "http://agent.test";
const silentLogger: Logger = { info() {}, error() {} };
const clock: Clock = { now: () => new Date("2026-10-10T12:00:00.000Z") };

// A desktop whose capture never answers until the lease is cancelled, so the first task
// holds the desktop and the second waits behind it.
class HangingSession {
  closed = false;
  inputsAfterClose = 0;
  inputs = 0;
  constructor(readonly index: number) {}
  get screen() {
    return { width: 4, height: 4 };
  }
  capture(input: { signal: AbortSignal }): Promise<never> {
    return new Promise((_, reject) => {
      if (input.signal.aborted) return reject(input.signal.reason);
      input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
    });
  }
  async pointer() {
    this.record();
  }
  async key() {
    this.record();
  }
  private record() {
    if (this.closed) this.inputsAfterClose++;
    else this.inputs++;
  }
  async close() {
    this.closed = true;
  }
}

// File-backed so the test can read final statuses after shutdown closes the app's database.
const DIR = mkdtempSync(join(tmpdir(), "shutdown-test-"));
const DB_PATH = join(DIR, "agent.sqlite");

function config(): AppConfig {
  return {
    port: 0,
    bearerToken: TOKEN,
    openRouterApiKey: "k",
    databasePath: DB_PATH,
    artifactDir: "./artifacts-test",
    taskTimeoutMs: 300_000,
    models: {
      perception: "anthropic/claude-haiku-5.5",
      perceptionFallback: "deepseek/deepseek-v4.1-flash",
      decision: "jev-latest",
      decisionFallback: "openai/gpt-6-luna-decisions",
      planner: "anthropic/claude-haiku-5.5",
      plannerFallback: "deepseek/deepseek-v4.1-flash",
    },
  };
}

function call(app: App, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${TOKEN}`);
  return app.fetch(new Request(BASE + path, { ...init, headers }));
}

async function submit(app: App, tarea: string): Promise<string> {
  const response = await call(app, "/tasks", {
    method: "POST",
    body: JSON.stringify({ tarea, escritorio: DESKTOP }),
    headers: { "content-type": "application/json" },
  });
  expect(response.status).toBe(202);
  return ((await response.json()) as { task_id: string }).task_id;
}

function storedStatus(id: string): { estado: string; resumen: string } {
  const db = openDatabase(DB_PATH);
  try {
    const row = db.query<{ status: string; summary: string }, [string]>("SELECT status, summary FROM tasks WHERE id = ?").get(id);
    if (!row) throw new Error(`task ${id} not stored`);
    return { estado: row.status, resumen: row.summary };
  } finally {
    db.close();
  }
}

describe("shutdown with active and queued tasks", () => {
  test("cancels the holder, rejects the queued task, closes the session, and sends no input afterwards", async () => {
    const sessions: HangingSession[] = [];
    const app = createApp(config(), {
      logger: silentLogger,
      clock,
      databasePath: DB_PATH,
      desktopSessions: {
        async connect() {
          const session = new HangingSession(sessions.length);
          sessions.push(session);
          return session;
        },
      },
      artifacts: { async storeScreenshot() { return { ref: "x", sha256: "0", bytes: 0 }; } },
      models: stubModels(),
      planner: new ScriptedPlanner(async () => "end"),
    });

    const holder = await submit(app, "Tarea que ocupa el escritorio");
    const queued = await submit(app, "Tarea en cola");
    // Wait until the holder has connected and the queued task is waiting for the lease.
    for (let i = 0; i < 400 && sessions.length === 0; i++) await Bun.sleep(5);
    expect(sessions.length).toBe(1);

    const started = performance.now();
    await app.shutdown();
    const elapsed = performance.now() - started;

    const a = storedStatus(holder);
    const b = storedStatus(queued);
    expect(a).toEqual({ estado: "fallida", resumen: CANCELLED_SUMMARY });
    expect(b).toEqual({ estado: "fallida", resumen: CANCELLED_SUMMARY });
    expect(sessions[0]!.closed).toBe(true);
    expect(sessions[0]!.inputsAfterClose).toBe(0);
    // Shutdown is bounded by the grace period plus the trace flush, with margin for scheduling.
    expect(elapsed).toBeLessThan(SHUTDOWN_GRACE_MS + TRACE_FLUSH_MS + 1_000);
  });

  test("cleanup", () => rmSync(DIR, { recursive: true, force: true }));
});
