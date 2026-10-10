import { describe, expect, test } from "bun:test";
import {
  CANCELLED_SUMMARY,
  DEADLINE_SUMMARY,
  EXPIRED_QUEUE_SUMMARY,
  ExecuteTask,
  NOT_IMPLEMENTED_SUMMARY,
} from "../../src/application/usecases/execute-task.ts";
import { DesktopOwnership } from "../../src/application/desktop/desktop-ownership.ts";
import type { DesktopSession, DesktopSessionFactory } from "../../src/application/ports/desktop-session.ts";
import type { TaskRepository } from "../../src/application/ports/task-repository.ts";
import { TraceRecorder } from "../../src/application/trace/trace-recorder.ts";
import { abortError, DesktopError } from "../../src/domain/desktop/errors.ts";
import { createScreenshot } from "../../src/domain/desktop/screenshot.ts";
import type { DesktopAccess } from "../../src/domain/tasks/contracts.ts";
import { createTask, finishTask, type Task } from "../../src/domain/tasks/task.ts";
import { openDatabase } from "../../src/adapters/outbound/sqlite/database.ts";
import { SqliteTaskRepository } from "../../src/adapters/outbound/sqlite/sqlite-task-repository.ts";
import { SqliteTraceRepository } from "../../src/adapters/outbound/sqlite/sqlite-trace-repository.ts";
import type { ArtifactStore } from "../../src/application/ports/artifact-store.ts";

const clock = { now: () => new Date() };
const logger = { info() {}, error() {} };
const SECRET = "clave-escritorio-xyz";

// Scripted desktop. Every connect, input, and close is logged in order.
// A desk URL containing "refuse" fails to connect; "hang" blocks each capture until
// the lease is aborted; a gate (see below) holds a capture until the test releases it.
class ScriptedDesks implements DesktopSessionFactory {
  readonly log: string[] = [];
  readonly gates = new Map<string, Promise<void>>();

  async connect(desktop: DesktopAccess, signal: AbortSignal): Promise<DesktopSession> {
    if (desktop.url.includes("refuse")) {
      throw new DesktopError("connection_failed", "refused");
    }
    const name = desktop.url;
    this.log.push(`connect:${name}`);
    const desks = this;
    return {
      screen: { width: 8, height: 8 },
      async capture(input) {
        desks.log.push(`capture:${name}`);
        const gate = desks.gates.get(name);
        if (gate) await Promise.race([gate, abortPromise(signal)]);
        if (desktop.url.includes("hang")) await abortPromise(signal);
        if (signal.aborted) throw abortError(signal);
        return createScreenshot({
          observationId: input.observationId,
          capturedAt: new Date(),
          width: 8,
          height: 8,
          frameRevision: 1,
          rgba: new Uint8Array(8 * 8 * 4),
        });
      },
      async pointer() {
        desks.log.push(`pointer:${name}`);
      },
      async key() {
        desks.log.push(`key:${name}`);
      },
      async close() {
        desks.log.push(`close:${name}`);
      },
    };
  }
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(abortError(signal));
    signal.addEventListener("abort", () => reject(abortError(signal)), { once: true });
  });
}

class LoggingTaskRepository implements TaskRepository {
  constructor(
    private readonly inner: TaskRepository,
    private readonly log: string[],
  ) {}
  async save(task: Task): Promise<void> {
    if (task.status !== "en_curso") this.log.push(`save:${task.status}`);
    await this.inner.save(task);
  }
  findById(id: string) {
    return this.inner.findById(id);
  }
  findInProgress() {
    return this.inner.findInProgress();
  }
}

function harness() {
  const database = openDatabase(":memory:");
  const desks = new ScriptedDesks();
  const repository = new LoggingTaskRepository(new SqliteTaskRepository(database), desks.log);
  const traceRepository = new SqliteTraceRepository(database);
  const trace = new TraceRecorder({ repository: traceRepository, clock, ids: counterIds(), logger });
  const artifacts: ArtifactStore = {
    async storeScreenshot() {
      return { ref: "x.png", sha256: "0", bytes: 0 };
    },
  };
  const execute = new ExecuteTask({
    repository,
    clock,
    ids: counterIds(),
    ownership: new DesktopOwnership(clock),
    sessions: desks,
    trace,
    artifacts,
  });
  return { database, desks, repository, trace, traceRepository, execute };
}

let idCounter = 0;
function counterIds() {
  return { next: () => `id-${++idCounter}` };
}

async function newTask(
  h: ReturnType<typeof harness>,
  url: string,
  timeoutMs = 5_000,
): Promise<{ id: string; desktop: DesktopAccess }> {
  const task = createTask({ id: `t-${++idCounter}`, instruction: "Registra algo", now: new Date(), timeoutMs });
  await new SqliteTaskRepository(h.database).save(task);
  return { id: task.id, desktop: { url, password: SECRET } };
}

async function statusOf(h: ReturnType<typeof harness>, id: string) {
  return new SqliteTaskRepository(h.database).findById(id);
}

// Starts a task that blocks on the desktop until its controller is aborted.
async function startHolder(h: ReturnType<typeof harness>, url: string) {
  const task = await newTask(h, url, 5_000);
  h.desks.gates.set(url, new Promise(() => {}));
  const controller = new AbortController();
  const done = h.execute.execute({ taskId: task.id, desktop: task.desktop, signal: controller.signal });
  await sleep(20);
  return { controller, done };
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

describe("task execution with desktop ownership", () => {
  test("observes once, closes the session, then stores the terminal status", async () => {
    const h = harness();
    const task = await newTask(h, "wss://desk-a");
    await h.execute.execute({ taskId: task.id, desktop: task.desktop, signal: new AbortController().signal });

    expect(h.desks.log).toEqual(["connect:wss://desk-a", "capture:wss://desk-a", "close:wss://desk-a", "save:fallida"]);
    const stored = await statusOf(h, task.id);
    expect(stored?.status).toBe("fallida");
    expect(stored?.summary).toBe(NOT_IMPLEMENTED_SUMMARY);
  });

  test("a queued task expires at its deadline without connecting to the desktop", async () => {
    const h = harness();
    const holder = await startHolder(h, "wss://desk-a");

    const waiting = await newTask(h, "wss://desk-a", 60);
    await h.execute.execute({ taskId: waiting.id, desktop: waiting.desktop, signal: new AbortController().signal });

    expect((await statusOf(h, waiting.id))?.summary).toBe(EXPIRED_QUEUE_SUMMARY);
    expect(h.desks.log.filter((entry) => entry.startsWith("connect"))).toEqual(["connect:wss://desk-a"]);
    expect(h.desks.log.some((entry) => entry.startsWith("capture") && entry.includes("desk-a") && entry !== "capture:wss://desk-a")).toBe(false);
    expect(h.desks.log.some((entry) => entry.startsWith("pointer") || entry.startsWith("key"))).toBe(false);
    holder.controller.abort();
    await holder.done;
  });

  test("a queued task that is cancelled never connects", async () => {
    const h = harness();
    const holder = await startHolder(h, "wss://desk-a");

    const waiting = await newTask(h, "wss://desk-a", 5_000);
    const controller = new AbortController();
    const pending = h.execute.execute({ taskId: waiting.id, desktop: waiting.desktop, signal: controller.signal });
    await sleep(10);
    controller.abort();
    await pending;

    expect((await statusOf(h, waiting.id))?.summary).toBe(CANCELLED_SUMMARY);
    expect(h.desks.log.filter((entry) => entry.startsWith("connect"))).toEqual(["connect:wss://desk-a"]);
    holder.controller.abort();
    await holder.done;
  });

  test("a connection failure ends the task without any input", async () => {
    const h = harness();
    const task = await newTask(h, "wss://refuse-me");
    await h.execute.execute({ taskId: task.id, desktop: task.desktop, signal: new AbortController().signal });

    const stored = await statusOf(h, task.id);
    expect(stored?.status).toBe("fallida");
    expect(stored?.summary).toContain("connection_failed");
    expect(stored?.summary).not.toContain(SECRET);
    expect(h.desks.log.some((entry) => entry.startsWith("pointer") || entry.startsWith("key"))).toBe(false);
  });

  test("a deadline during observation stops the desktop before the terminal status is stored", async () => {
    const h = harness();
    const task = await newTask(h, "wss://hang-desk", 60);
    await h.execute.execute({ taskId: task.id, desktop: task.desktop, signal: new AbortController().signal });

    expect((await statusOf(h, task.id))?.summary).toBe(DEADLINE_SUMMARY);
    const closeIndex = h.desks.log.indexOf("close:wss://hang-desk");
    const saveIndex = h.desks.log.indexOf("save:fallida");
    expect(closeIndex).toBeGreaterThanOrEqual(0);
    expect(closeIndex).toBeLessThan(saveIndex);
  });

  test("tasks on different desktops run concurrently", async () => {
    const h = harness();
    const a = await startHolder(h, "wss://desk-a");
    const b = await startHolder(h, "wss://desk-b");
    expect(h.desks.log.filter((entry) => entry.startsWith("connect"))).toEqual([
      "connect:wss://desk-a",
      "connect:wss://desk-b",
    ]);
    a.controller.abort();
    b.controller.abort();
    await Promise.all([a.done, b.done]);
  });

  test("the trace records queue, lease, deadline, and disconnect events without the password", async () => {
    const h = harness();
    const task = await newTask(h, "wss://hang-desk", 60);
    await h.execute.execute({ taskId: task.id, desktop: task.desktop, signal: new AbortController().signal });
    await h.trace.flush(1_000);

    const kinds = (await h.traceRepository.forTask(task.id)).map((event) => event.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(["task_started", "desktop_acquired", "desktop_connected", "deadline_reached", "desktop_released", "task_finished"]),
    );
    const everything = JSON.stringify(await h.traceRepository.forTask(task.id));
    expect(everything).not.toContain(SECRET);
  });
});
