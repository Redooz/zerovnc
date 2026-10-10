// Disk cache for perception output, keyed by the screenshot's pixels plus the model and
// prompt that produced it. Decision comparisons then share identical evidence, and
// reruns do not pay for perception again. Failures are never cached.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRoute } from "../../src/application/models/route.ts";
import type { PerceptionOutput, PerceptionRequest } from "../../src/application/ports/perception-model.ts";

export interface PerceptionCacheStats {
  hits: number;
  misses: number;
}

export function perceptionCacheKey(request: PerceptionRequest, salt: string): string {
  const { screenshot } = request;
  return createHash("sha256")
    .update(`${screenshot.width}x${screenshot.height}|${salt}|`)
    .update(screenshot.rgba)
    .digest("hex")
    .slice(0, 40);
}

export function cachedPerception(
  route: ModelRoute<PerceptionRequest, PerceptionOutput>,
  dir: string,
  salt: string,
  stats: PerceptionCacheStats,
): ModelRoute<PerceptionRequest, PerceptionOutput> {
  mkdirSync(dir, { recursive: true });
  return {
    model: route.model,
    async call(request: PerceptionRequest): Promise<PerceptionOutput> {
      const file = join(dir, `${perceptionCacheKey(request, `${route.model}|${salt}`)}.json`);
      if (existsSync(file)) {
        stats.hits += 1;
        return JSON.parse(readFileSync(file, "utf8")) as PerceptionOutput;
      }
      const output = await route.call(request);
      writeFileSync(file, JSON.stringify(output));
      stats.misses += 1;
      return output;
    },
  };
}
