import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../../src/bootstrap/server.ts";
import type { AppConfig } from "../../src/bootstrap/config.ts";
import type { Logger } from "../../src/application/ports/logger.ts";
import type { Clock } from "../../src/application/ports/clock.ts";
import { ScriptedPlanner, stubModels } from "../support/agent-doubles.ts";
import { createScreenshot } from "../../src/domain/desktop/screenshot.ts";
import { INTERRUPTED_BY_RESTART_SUMMARY } from "../../src/application/usecases/fail-interrupted-tasks.ts";

const TOKEN = "test-token-0123456789abcdef";
const DESKTOP_PASSWORD = "clave-del-escritorio-789";
const BASE = "http://agent.test";

const silentLogger: Logger = { info() {}, error() {} };
const clock: Clock = { now: () => new Date("2026-10-10T12:00:00.000Z") };

// Stub desktop: connects instantly and returns a blank screen, so HTTP tests never
// open network connections or write artifacts to disk.
const stubs = {
  models: stubModels(),
  // Ends every task with a blocker: no model calls, no input beyond one observation.
  planner: new ScriptedPlanner(async () => [{ name: "report_blocker", args: { reason: "prueba" } }]),
  desktopSessions: {
    async connect() {
      return {
        screen: { width: 4, height: 4 },
        async capture(input: { observationId: string }) {
          return createScreenshot({
            observationId: input.observationId,
            capturedAt: new Date(clock.now()),
            width: 4,
            height: 4,
            frameRevision: 1,
            rgba: new Uint8Array(4 * 4 * 4),
          });
        },
        async pointer() {},
        async key() {},
        async close() {},
      };
    },
  },
  artifacts: {
    async storeScreenshot() {
      return { ref: "test/none.png", sha256: "0", bytes: 0 };
    },
  },
};

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0,
    bearerToken: TOKEN,
    openRouterApiKey: "k",
    databasePath: ":memory:",
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
    ...overrides,
  };
}

const validBody = {
  tarea: "Registra al cliente Papelería Los Andes, NIT 901234567, teléfono 3157654321, ciudad Pereira.",
  escritorio: { url: "wss://escritorio.example/websockify", password: DESKTOP_PASSWORD },
};

function call(app: App, path: string, init: RequestInit = {}, token: string | null = TOKEN): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  return app.fetch(new Request(BASE + path, { ...init, headers }));
}

function post(app: App, body: unknown, token: string | null = TOKEN): Promise<Response> {
  return call(app, "/tasks", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }, token);
}

async function waitForTerminal(app: App, taskId: string): Promise<{ estado: string; resumen: string }> {
  for (let i = 0; i < 200; i++) {
    const body = (await (await call(app, `/tasks/${taskId}`)).json()) as { estado: string; resumen: string };
    if (body.estado !== "en_curso") return body;
    await Bun.sleep(5);
  }
  throw new Error("task did not finish");
}

let app: App;
let dir: string;

beforeEach(() => {
  app = createApp(config(), { logger: silentLogger, clock, ...stubs });
});

afterEach(async () => {
  await app.shutdown();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("authentication", () => {
  test("every endpoint requires the bearer token", async () => {
    expect((await call(app, "/health", {}, null)).status).toBe(401);
    expect((await call(app, "/health", {}, "wrong-token-value-xxxx")).status).toBe(401);
    expect((await post(app, validBody, null)).status).toBe(401);
    expect((await call(app, "/tasks/abc", {}, null)).status).toBe(401);
  });
});

describe("health", () => {
  test("GET /health returns 200 when authorized", async () => {
    const response = await call(app, "/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe("POST /tasks", () => {
  test("accepts a valid task with 202 and returns task_id", async () => {
    const response = await post(app, validBody);
    expect(response.status).toBe(202);
    const body = (await response.json()) as { task_id: string };
    expect(body.task_id.length).toBeGreaterThan(0);
  });

  test("rejects invalid bodies without echoing the password", async () => {
    const bad = { tarea: "x", escritorio: { url: "https://no-ws.example", password: DESKTOP_PASSWORD } };
    const response = await post(app, bad);
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain("escritorio.url");
    expect(text).not.toContain(DESKTOP_PASSWORD);
  });

  test("rejects malformed JSON and oversized bodies", async () => {
    const malformed = await call(app, "/tasks", { method: "POST", body: "{nope" });
    expect(malformed.status).toBe(400);
    const oversized = await call(app, "/tasks", {
      method: "POST",
      body: JSON.stringify({ tarea: "x".repeat(70_000), escritorio: validBody.escritorio }),
    });
    expect(oversized.status).toBe(413);
  });

  test("GET /tasks is not allowed", async () => {
    expect((await call(app, "/tasks")).status).toBe(405);
  });
});

describe("GET /tasks/{id}", () => {
  test("returns en_curso and then a terminal status with a summary", async () => {
    const accepted = (await (await post(app, validBody)).json()) as { task_id: string };
    const final = await waitForTerminal(app, accepted.task_id);
    expect(final.estado).toBe("fallida");
    expect(final.resumen).toBe("La tarea no se pudo completar: prueba");
  });

  test("never includes the desktop password in any response", async () => {
    const accepted = (await (await post(app, validBody)).json()) as { task_id: string };
    const final = await waitForTerminal(app, accepted.task_id);
    expect(JSON.stringify(final)).not.toContain(DESKTOP_PASSWORD);
  });

  test("unknown ids return 404", async () => {
    expect((await call(app, "/tasks/does-not-exist")).status).toBe(404);
  });

  test("unknown paths return 404", async () => {
    expect((await call(app, "/nope")).status).toBe(404);
  });
});

describe("shutdown and restart", () => {
  test("after shutdown, new submissions are refused", async () => {
    await app.shutdown();
    const response = await post(app, validBody);
    expect(response.status).toBe(503);
    // Restore a live app for afterEach's shutdown to be a no-op.
    app = createApp(config(), { logger: silentLogger, clock, ...stubs });
  });

  test("tasks interrupted by a restart become fallida, and terminal tasks are kept", async () => {
    dir = mkdtempSync(join(tmpdir(), "zerovnc-restart-"));
    const path = join(dir, "agent.sqlite");

    // First process: create a task that stays en_curso (no worker finished it).
    const first = createApp(config({ databasePath: path }), { logger: silentLogger, clock, ...stubs });
    const { createTask } = await import("../../src/domain/tasks/task.ts");
    const { SqliteTaskRepository } = await import("../../src/adapters/outbound/sqlite/sqlite-task-repository.ts");
    const repo = new SqliteTaskRepository(first.database);
    await repo.save(createTask({ id: "running", instruction: "x", now: clock.now(), timeoutMs: 300_000 }));
    const { finishTask } = await import("../../src/domain/tasks/task.ts");
    await repo.save(finishTask(createTask({ id: "done", instruction: "x", now: clock.now(), timeoutMs: 1 }), "terminada", "ya estaba", clock.now()));
    await first.shutdown(); // simulates the process going away

    // Second process: startup recovery.
    const second = createApp(config({ databasePath: path }), { logger: silentLogger, clock, ...stubs });
    expect(await second.recoverInterruptedTasks()).toBe(1);
    const running = await call(second, "/tasks/running");
    expect(await running.json()).toEqual({ estado: "fallida", resumen: INTERRUPTED_BY_RESTART_SUMMARY });
    const done = await call(second, "/tasks/done");
    expect(await done.json()).toEqual({ estado: "terminada", resumen: "ya estaba" });
    await second.shutdown();
    app = createApp(config(), { logger: silentLogger, clock, ...stubs }); // keep afterEach valid
  });
});
