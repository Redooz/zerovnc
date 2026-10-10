// Local exact-frame perception cache. Reuses a validated perception draft only when the
// pixels, dimensions, models, and prompt/schema version are identical. Task-scoped:
// create one per task and clear it when the task ends. Bounded in size and age. It never
// replaces a fresh capture or the repaint wait: the screenshot is always taken first, and
// a hit only saves the model call for that exact frame.
import { createHash } from "node:crypto";
import type { Screenshot } from "../../domain/desktop/screenshot.ts";
import type { Clock } from "../ports/clock.ts";
import type { PerceptionOutput } from "../ports/perception-model.ts";

export interface FrameCacheOptions {
  readonly maxEntries: number;
  // Entries older than this are treated as absent. Should not exceed the task limit.
  readonly ttlMs: number;
  readonly clock: Clock;
}

export const DEFAULT_FRAME_CACHE_ENTRIES = 8;
export const DEFAULT_FRAME_CACHE_TTL_MS = 300_000;

export interface FrameCacheStats {
  hits: number;
  misses: number;
  expired: number;
  evicted: number;
}

interface Entry {
  readonly output: PerceptionOutput;
  readonly fallbackReason: string | null;
  readonly storedAtMs: number;
}

export class PerceptionFrameCache {
  private readonly entries = new Map<string, Entry>();
  readonly stats: FrameCacheStats = { hits: 0, misses: 0, expired: 0, evicted: 0 };

  constructor(private readonly options: FrameCacheOptions) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) throw new Error("maxEntries must be a positive integer");
    if (!(options.ttlMs > 0)) throw new Error("ttlMs must be positive");
  }

  // Identical key means identical evidence: same pixels and size, same model chain, same
  // prompt/schema version. Observation id, capture time, and frame revision are excluded,
  // because a hit is rebound to the new frame's identity by the caller.
  static keyFor(screenshot: Screenshot, models: readonly string[], version: string): string {
    return createHash("sha256")
      .update(`${screenshot.width}x${screenshot.height}|${models.join(",")}|${version}|`)
      .update(screenshot.rgba)
      .digest("hex");
  }

  get(key: string): { readonly output: PerceptionOutput; readonly fallbackReason: string | null } | null {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      this.stats.misses += 1;
      return null;
    }
    if (this.options.clock.now().getTime() - entry.storedAtMs > this.options.ttlMs) {
      this.entries.delete(key);
      this.stats.expired += 1;
      this.stats.misses += 1;
      return null;
    }
    // Refresh recency: re-insert so the least recently used entry is first.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.stats.hits += 1;
    return { output: entry.output, fallbackReason: entry.fallbackReason };
  }

  set(key: string, output: PerceptionOutput, fallbackReason: string | null): void {
    this.entries.delete(key);
    this.entries.set(key, { output, fallbackReason, storedAtMs: this.options.clock.now().getTime() });
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
      this.stats.evicted += 1;
    }
  }

  // Call when the task ends.
  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
