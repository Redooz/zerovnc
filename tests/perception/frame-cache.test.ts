import { describe, expect, test } from "bun:test";
import { PerceptionFrameCache } from "../../src/application/perception/frame-cache.ts";
import { PerceiveScreen } from "../../src/application/perception/perceive-screen.ts";
import type { ModelRoute } from "../../src/application/models/route.ts";
import type { PerceptionOutput, PerceptionRequest } from "../../src/application/ports/perception-model.ts";
import type { ModelCallEvent } from "../../src/application/ports/model-call-observer.ts";
import { ModelCallError } from "../../src/application/ports/model-call-error.ts";
import { createScreenshot } from "../../src/domain/desktop/screenshot.ts";

const W = 8;
const H = 8;
function shot(over: { fill?: number; id?: string; at?: number; revision?: number; poke?: number } = {}) {
  const rgba = new Uint8Array(W * H * 4).fill(over.fill ?? 10);
  if (over.poke !== undefined) rgba[over.poke] = 99;
  return createScreenshot({
    observationId: over.id ?? "obs-1",
    capturedAt: new Date(over.at ?? 1_000),
    width: W,
    height: H,
    frameRevision: over.revision ?? 1,
    rgba,
  });
}
const element = { id: "e1", label: "Guardar", kind: "button" as const, value: { state: "not_applicable" as const }, box: { x: 1, y: 1, w: 4, h: 4 }, visible: true };
const metadata = { model: "haiku", servedBy: "haiku", promptVersion: "perception.vT", promptTokens: 900, completionTokens: 300, costUsd: 0.001, latencyMs: 7000 };

class CountingRoute implements ModelRoute<PerceptionRequest, PerceptionOutput> {
  calls = 0;
  constructor(readonly model: string, private readonly behavior: () => PerceptionOutput = () => ({ draft: { elements: [element], relations: [], rejectedElements: 0 }, metadata })) {}
  async call(): Promise<PerceptionOutput> {
    this.calls += 1;
    return this.behavior();
  }
}

function clock() {
  let t = 0;
  return { now: () => new Date(t), advance: (ms: number) => void (t += ms) };
}
const noAbort = () => new AbortController().signal;

function setup(opts: { maxEntries?: number; ttlMs?: number; version?: string; primary?: CountingRoute; fallback?: CountingRoute } = {}) {
  const c = clock();
  const store = new PerceptionFrameCache({ maxEntries: opts.maxEntries ?? 8, ttlMs: opts.ttlMs ?? 60_000, clock: c });
  const primary = opts.primary ?? new CountingRoute("haiku");
  const fallback = opts.fallback ?? new CountingRoute("deepseek");
  const events: ModelCallEvent[] = [];
  const perceive = new PerceiveScreen({ primary, fallback, timeoutMs: 1000, observe: (e) => events.push(e), cache: { store, version: opts.version ?? "perception.v3" } });
  return { c, store, primary, fallback, events, perceive };
}

describe("exact-frame perception cache", () => {
  test("a miss calls the model; an identical frame then hits without calling it", async () => {
    const { perceive, primary } = setup();
    const first = await perceive.perceive({ taskId: "t", screenshot: shot(), signal: noAbort() });
    const second = await perceive.perceive({ taskId: "t", screenshot: shot({ id: "obs-2", at: 5_000, revision: 4 }), signal: noAbort() });
    expect(primary.calls).toBe(1);
    expect(first).toMatchObject({ status: "observed", cache: "miss" });
    expect(second).toMatchObject({ status: "observed", cache: "hit" });
  });

  test("a hit is rebound to the new frame's identity, not the cached one", async () => {
    const { perceive } = setup();
    await perceive.perceive({ taskId: "t", screenshot: shot({ id: "obs-1", at: 1_000, revision: 1 }), signal: noAbort() });
    const hit = await perceive.perceive({ taskId: "t", screenshot: shot({ id: "obs-2", at: 5_000, revision: 4 }), signal: noAbort() });
    if (hit.status !== "observed") throw new Error("expected observed");
    expect(hit.observation.id).toBe("obs-2");
    expect(hit.observation.capturedAt.getTime()).toBe(5_000);
    expect(hit.observation.frameRevision).toBe(4);
    expect(hit.observation.elements[0]?.label).toBe("Guardar");
  });

  test("a hit costs nothing: zero tokens, zero cost, zero latency, and the trace says so", async () => {
    const { perceive, events } = setup();
    await perceive.perceive({ taskId: "t", screenshot: shot(), signal: noAbort() });
    const hit = await perceive.perceive({ taskId: "t", screenshot: shot({ id: "obs-2" }), signal: noAbort() });
    if (hit.status !== "observed") throw new Error("expected observed");
    expect(hit.metadata).toMatchObject({ promptTokens: 0, completionTokens: 0, costUsd: 0, latencyMs: 0 });
    expect(events.map((e) => e.localCache)).toEqual(["miss", "hit"]);
    expect(events[1]).toMatchObject({ outcome: "ok", costUsd: 0, servedBy: "haiku" });
  });

  test("changed pixels miss: one different byte means a new model call", async () => {
    const { perceive, primary } = setup();
    await perceive.perceive({ taskId: "t", screenshot: shot(), signal: noAbort() });
    const changed = await perceive.perceive({ taskId: "t", screenshot: shot({ poke: 17 }), signal: noAbort() });
    expect(primary.calls).toBe(2);
    expect(changed).toMatchObject({ cache: "miss" });
  });

  test("a different model chain or prompt version never shares entries", () => {
    const s = shot();
    const base = PerceptionFrameCache.keyFor(s, ["haiku", "deepseek"], "perception.v3");
    expect(PerceptionFrameCache.keyFor(s, ["haiku", "deepseek"], "perception.v3")).toBe(base);
    expect(PerceptionFrameCache.keyFor(s, ["sonnet", "deepseek"], "perception.v3")).not.toBe(base);
    expect(PerceptionFrameCache.keyFor(s, ["haiku", "other"], "perception.v3")).not.toBe(base);
    expect(PerceptionFrameCache.keyFor(s, ["haiku", "deepseek"], "perception.v4")).not.toBe(base);
  });

  test("the same pixels at different dimensions are different frames", () => {
    const wide = createScreenshot({ observationId: "o", capturedAt: new Date(0), width: 16, height: 4, frameRevision: 1, rgba: new Uint8Array(16 * 4 * 4).fill(10) });
    const tall = createScreenshot({ observationId: "o", capturedAt: new Date(0), width: 4, height: 16, frameRevision: 1, rgba: new Uint8Array(4 * 16 * 4).fill(10) });
    expect(PerceptionFrameCache.keyFor(wide, ["m"], "v")).not.toBe(PerceptionFrameCache.keyFor(tall, ["m"], "v"));
  });

  test("entries expire: after the TTL the frame is perceived again", async () => {
    const { perceive, primary, c, store } = setup({ ttlMs: 10_000 });
    await perceive.perceive({ taskId: "t", screenshot: shot(), signal: noAbort() });
    c.advance(9_000);
    expect(await perceive.perceive({ taskId: "t", screenshot: shot(), signal: noAbort() })).toMatchObject({ cache: "hit" });
    c.advance(11_000);
    expect(await perceive.perceive({ taskId: "t", screenshot: shot(), signal: noAbort() })).toMatchObject({ cache: "miss" });
    expect(primary.calls).toBe(2);
    expect(store.stats.expired).toBe(1);
  });

  test("the cache is bounded: the least recently used frame is evicted", async () => {
    const { perceive, store } = setup({ maxEntries: 2 });
    for (const fill of [1, 2, 3]) await perceive.perceive({ taskId: "t", screenshot: shot({ fill }), signal: noAbort() });
    expect(store.size).toBe(2);
    expect(store.stats.evicted).toBe(1);
    // Frame 1 was evicted (oldest); frame 3 is still cached.
    expect(await perceive.perceive({ taskId: "t", screenshot: shot({ fill: 3 }), signal: noAbort() })).toMatchObject({ cache: "hit" });
    expect(await perceive.perceive({ taskId: "t", screenshot: shot({ fill: 1 }), signal: noAbort() })).toMatchObject({ cache: "miss" });
  });

  test("a recently used entry survives eviction", async () => {
    const { perceive } = setup({ maxEntries: 2 });
    await perceive.perceive({ taskId: "t", screenshot: shot({ fill: 1 }), signal: noAbort() });
    await perceive.perceive({ taskId: "t", screenshot: shot({ fill: 2 }), signal: noAbort() });
    await perceive.perceive({ taskId: "t", screenshot: shot({ fill: 1 }), signal: noAbort() }); // touch 1
    await perceive.perceive({ taskId: "t", screenshot: shot({ fill: 3 }), signal: noAbort() }); // evicts 2
    expect(await perceive.perceive({ taskId: "t", screenshot: shot({ fill: 1 }), signal: noAbort() })).toMatchObject({ cache: "hit" });
    expect(await perceive.perceive({ taskId: "t", screenshot: shot({ fill: 2 }), signal: noAbort() })).toMatchObject({ cache: "miss" });
  });

  test("clearing at task end empties the cache", async () => {
    const { perceive, store, primary } = setup();
    await perceive.perceive({ taskId: "t", screenshot: shot(), signal: noAbort() });
    store.clear();
    expect(store.size).toBe(0);
    await perceive.perceive({ taskId: "t", screenshot: shot(), signal: noAbort() });
    expect(primary.calls).toBe(2);
  });

  test("failures are never cached: a failed call is retried on the next identical frame", async () => {
    let fail = true;
    const flaky = new CountingRoute("haiku", () => {
      if (fail) throw new ModelCallError("provider", "HTTP 502", true);
      return { draft: { elements: [element], relations: [], rejectedElements: 0 }, metadata };
    });
    const { perceive } = setup({ primary: flaky, fallback: new CountingRoute("deepseek", () => { throw new ModelCallError("provider", "HTTP 503", true); }) });
    expect(await perceive.perceive({ taskId: "t", screenshot: shot(), signal: noAbort() })).toMatchObject({ status: "abstained" });
    fail = false;
    expect(await perceive.perceive({ taskId: "t", screenshot: shot(), signal: noAbort() })).toMatchObject({ status: "observed", cache: "miss" });
  });

  test("an output that fails observation validation (no grounded elements) is not cached", async () => {
    const empty = new CountingRoute("haiku", () => ({ draft: { elements: [], relations: [], rejectedElements: 3 }, metadata }));
    const { perceive, store } = setup({ primary: empty, fallback: new CountingRoute("deepseek", () => ({ draft: { elements: [], relations: [], rejectedElements: 3 }, metadata })) });
    expect(await perceive.perceive({ taskId: "t", screenshot: shot(), signal: noAbort() })).toMatchObject({ status: "abstained", reason: "no_grounded_elements" });
    expect(store.size).toBe(0);
  });

  test("without a cache configured, every frame calls the model and reports cache off", async () => {
    const primary = new CountingRoute("haiku");
    const perceive = new PerceiveScreen({ primary, fallback: new CountingRoute("deepseek"), timeoutMs: 1000 });
    const a = await perceive.perceive({ taskId: "t", screenshot: shot(), signal: noAbort() });
    await perceive.perceive({ taskId: "t", screenshot: shot(), signal: noAbort() });
    expect(primary.calls).toBe(2);
    expect(a).toMatchObject({ cache: "off" });
  });

  test("invalid cache settings are rejected", () => {
    const c = clock();
    expect(() => new PerceptionFrameCache({ maxEntries: 0, ttlMs: 1, clock: c })).toThrow();
    expect(() => new PerceptionFrameCache({ maxEntries: 1, ttlMs: 0, clock: c })).toThrow();
  });
});
