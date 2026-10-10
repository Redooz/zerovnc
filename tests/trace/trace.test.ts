import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DesktopExecutor } from "../../src/application/desktop/desktop-executor.ts";
import type { DesktopSession } from "../../src/application/ports/desktop-session.ts";
import { redactValue, REDACTED } from "../../src/application/trace/redaction.ts";
import { TraceRecorder } from "../../src/application/trace/trace-recorder.ts";
import { formatTimeline } from "../../src/application/trace/format-timeline.ts";
import type { TraceRepository } from "../../src/application/ports/trace-repository.ts";
import type { TraceEvent } from "../../src/domain/execution/types.ts";
import { createScreenshot, type Screenshot } from "../../src/domain/desktop/screenshot.ts";
import { FileArtifactStore } from "../../src/adapters/outbound/artifacts/file-artifact-store.ts";
import { encodeRgbaPng } from "../../src/adapters/outbound/artifacts/png-encoder.ts";
import { openDatabase } from "../../src/adapters/outbound/sqlite/database.ts";
import { SqliteTraceRepository } from "../../src/adapters/outbound/sqlite/sqlite-trace-repository.ts";

const logger = { info() {}, error() {}, warn() {}, debug() {} } as never;
const TASK = "task-1";

class MemoryTraceRepository implements TraceRepository {
  readonly events: TraceEvent[] = [];
  failWith: Error | null = null;
  block: Promise<void> | null = null;
  async append(batch: readonly TraceEvent[]): Promise<void> {
    if (this.block) await this.block;
    if (this.failWith) throw this.failWith;
    this.events.push(...batch);
  }
  async forTask(taskId: string): Promise<readonly TraceEvent[]> {
    return this.events.filter((event) => event.taskId === taskId);
  }
}

function ids() {
  let n = 0;
  return { next: () => `id-${++n}` };
}

function recorderWith(repository: TraceRepository, secrets: string[] = []) {
  return new TraceRecorder(
    { repository, clock: { now: () => new Date("2026-10-10T12:00:00.000Z") }, ids: ids(), logger },
    secrets,
  );
}

describe("redaction", () => {
  test("replaces every secret occurrence at any depth without touching the input", () => {
    const input = { a: "pw=hunter2 and hunter2", nested: { list: ["x hunter2"], n: 3, when: new Date(0) } };
    const out = redactValue(input, ["hunter2"]);
    expect(out).toEqual({
      a: `pw=${REDACTED} and ${REDACTED}`,
      nested: { list: [`x ${REDACTED}`], n: 3, when: new Date(0) },
    });
    expect(input.a).toContain("hunter2");
  });

  test("ignores empty secrets", () => {
    expect(redactValue({ a: "abc" }, [""])).toEqual({ a: "abc" });
  });
});

describe("trace recorder", () => {
  test("stores events in record order with redacted payloads", async () => {
    const repository = new MemoryTraceRepository();
    const recorder = recorderWith(repository, ["bearer-secret-value"]);
    recorder.addSecret(TASK, "desk-pass");
    recorder.record({ taskId: TASK, kind: "task_received", payload: { note: "desk-pass and bearer-secret-value" } });
    recorder.record({ taskId: TASK, kind: "observation", payload: { n: 1 } });
    expect(await recorder.flush(1_000)).toBe(true);
    expect(repository.events.map((e) => e.kind)).toEqual(["task_received", "observation"]);
    expect(repository.events[0]!.payload).toEqual({ note: `${REDACTED} and ${REDACTED}` });
    expect(new Set(repository.events.map((e) => e.spanId)).size).toBe(2);
  });

  test("forgetSecrets stops redacting values for a finished task", async () => {
    const repository = new MemoryTraceRepository();
    const recorder = recorderWith(repository);
    recorder.addSecret(TASK, "gone-value");
    recorder.forgetSecrets(TASK);
    recorder.record({ taskId: TASK, kind: "task_finished", payload: { s: "gone-value" } });
    await recorder.flush(1_000);
    expect(repository.events[0]!.payload).toEqual({ s: "gone-value" });
  });

  test("flush returns false when storage is slower than the bound", async () => {
    const repository = new MemoryTraceRepository();
    let release!: () => void;
    repository.block = new Promise<void>((resolve) => (release = resolve));
    const recorder = recorderWith(repository);
    recorder.record({ taskId: TASK, kind: "observation" });
    const started = performance.now();
    expect(await recorder.flush(30)).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
    release();
    expect(await recorder.flush(1_000)).toBe(true);
  });

  test("a failed write is counted and does not throw", async () => {
    const repository = new MemoryTraceRepository();
    repository.failWith = new Error("disk full");
    const recorder = recorderWith(repository);
    recorder.record({ taskId: TASK, kind: "observation" });
    expect(await recorder.flush(1_000)).toBe(true);
    expect(recorder.droppedEvents).toBe(1);
  });
});

describe("sqlite trace repository", () => {
  test("round-trips events in order, keeping timestamps and payloads", async () => {
    const database = openDatabase(":memory:");
    const repository = new SqliteTraceRepository(database);
    const event = (kind: TraceEvent["kind"], n: number): TraceEvent => ({
      taskId: TASK,
      spanId: `s${n}`,
      parentSpanId: n > 1 ? "s1" : null,
      kind,
      at: new Date(`2026-10-10T12:00:0${n}.000Z`),
      payload: { n, ok: true },
    });
    await repository.append([event("task_received", 1), event("observation", 2)]);
    const stored = await repository.forTask(TASK);
    expect(stored).toEqual([event("task_received", 1), event("observation", 2)]);
    expect(await repository.forTask("other")).toEqual([]);
    database.close();
  });
});

describe("screenshot artifacts", () => {
  const shot: Screenshot = createScreenshot({
    observationId: "o-1",
    capturedAt: new Date("2026-10-10T12:00:00.000Z"),
    width: 2,
    height: 1,
    frameRevision: 1,
    rgba: Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 255),
  });

  test("PNG encodes with a valid signature and inflates back to the original pixels", () => {
    const png = encodeRgbaPng(2, 1, shot.rgba);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect(view.getUint32(16)).toBe(2); // width
    expect(view.getUint32(20)).toBe(1); // height
    // IDAT data starts after the IHDR chunk (8 + 25 bytes) plus 8 bytes of IDAT header.
    const idatLength = view.getUint32(33);
    const idat = png.subarray(41, 41 + idatLength);
    expect([...inflateSync(idat)]).toEqual([0, 255, 0, 0, 255, 0, 255, 0, 255]);
  });

  test("file store names artifacts by content hash and writes the exact PNG", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifacts-"));
    const store = new FileArtifactStore(root);
    const stored = await store.storeScreenshot({ taskId: TASK, screenshot: shot });
    const png = encodeRgbaPng(2, 1, shot.rgba);
    expect(stored.sha256).toBe(createHash("sha256").update(png).digest("hex"));
    expect(stored.ref).toBe(join(TASK, `${stored.sha256}.png`));
    expect([...(await readFile(join(root, stored.ref)))]).toEqual([...png]);
  });
});

describe("executor tracing", () => {
  test("records observations with artifact hashes and one event per action", async () => {
    const repository = new MemoryTraceRepository();
    const recorder = recorderWith(repository);
    const root = await mkdtemp(join(tmpdir(), "trace-exec-"));
    const session: DesktopSession = {
      screen: { width: 4, height: 4 },
      async capture(input) {
        return createScreenshot({
          observationId: input.observationId,
          capturedAt: new Date(),
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
    const executor = new DesktopExecutor({
      session,
      clock: { now: () => new Date() },
      ids: ids(),
      screen: { width: 4, height: 4 },
      signal: new AbortController().signal,
      timing: { clickHoldMs: 0, repaintMs: 0, keyGapMs: 0 },
      trace: { taskId: TASK, recorder, artifacts: new FileArtifactStore(root) },
    });
    const observation = await executor.observe();
    await executor.run([{ kind: "click", x: 1, y: 1, observationId: observation.observationId }]);
    await recorder.flush(1_000);

    const kinds = repository.events.map((e) => e.kind);
    expect(kinds).toEqual(["observation", "action"]);
    const observed = repository.events[0]!;
    expect(observed.payload.observation_id).toBe(observation.observationId);
    expect(observed.payload.artifact_sha256).toEqual(expect.any(String));
    expect(repository.events[1]!.payload).toMatchObject({ action: "click", status: "executed", observation_id: observation.observationId });
  });
});

describe("redaction overlaps", () => {
  test("a secret that contains another secret is redacted whole", () => {
    const out = redactValue({ text: "token=abcdef and abc" }, ["abc", "abcdef"]);
    expect(out.text).toBe(`token=${REDACTED} and ${REDACTED}`);
  });
});

describe("artifact bounds", () => {
  test("a screenshot artifact that never finishes is recorded as missing and does not block capture", async () => {
    const repository = new MemoryTraceRepository();
    const recorder = new TraceRecorder(
      { repository, clock: { now: () => new Date("2026-10-10T12:00:00.000Z") }, ids: ids(), logger },
      [],
    );
    const session: DesktopSession = {
      screen: { width: 4, height: 4 },
      async capture(input) {
        return createScreenshot({
          observationId: input.observationId,
          capturedAt: new Date(),
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
    let n = 0;
    const executor = new DesktopExecutor({
      session,
      clock: { now: () => new Date() },
      ids: { next: () => `obs-${++n}` },
      screen: { width: 4, height: 4 },
      signal: new AbortController().signal,
      timing: { clickHoldMs: 0, repaintMs: 0, keyGapMs: 0, artifactTimeoutMs: 30 },
      trace: { taskId: TASK, recorder, artifacts: { storeScreenshot: () => new Promise(() => {}) } },
    });
    const started = performance.now();
    const shot = await executor.observe();
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(shot.observationId).toBe("obs-1");
    await recorder.flush(1_000);
    const observed = repository.events.find((e) => e.kind === "observation")!;
    expect(observed.payload.artifact_ref).toBeNull();
    expect(repository.events.some((e) => e.kind === "error")).toBe(true);
    const lines = formatTimeline(repository.events);
    expect(lines.some((line) => line.includes("<- screenshot missing"))).toBe(true);
  });

  test("desktop events are recorded as children of the given parent span", async () => {
    const repository = new MemoryTraceRepository();
    const recorder = new TraceRecorder(
      { repository, clock: { now: () => new Date("2026-10-10T12:00:00.000Z") }, ids: ids(), logger },
      [],
    );
    const session: DesktopSession = {
      screen: { width: 4, height: 4 },
      async capture(input) {
        return createScreenshot({ observationId: input.observationId, capturedAt: new Date(), width: 4, height: 4, frameRevision: 1, rgba: new Uint8Array(64) });
      },
      async pointer() {},
      async key() {},
      async close() {},
    };
    const executor = new DesktopExecutor({
      session,
      clock: { now: () => new Date() },
      ids: { next: () => "obs" },
      screen: { width: 4, height: 4 },
      signal: new AbortController().signal,
      timing: { clickHoldMs: 0, repaintMs: 0, keyGapMs: 0 },
      trace: { taskId: TASK, recorder, parentSpanId: "task-span" },
    });
    await executor.observe();
    await recorder.flush(1_000);
    expect(repository.events.every((e) => e.parentSpanId === "task-span")).toBe(true);
  });
});

describe("timeline", () => {
  test("prints one line per event with its span and payload", () => {
    const lines = formatTimeline([
      {
        taskId: TASK,
        spanId: "s1",
        parentSpanId: null,
        kind: "action",
        at: new Date("2026-10-10T12:00:01.250Z"),
        payload: { status: "executed" },
      },
    ]);
    expect(lines).toEqual(['12:00:01.250  action             [s1] {"status":"executed"}']);
  });
});
