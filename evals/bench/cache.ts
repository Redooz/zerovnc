// Phase 3 step 3.7 measurement. Two caches, reported separately. Reads captured
// screenshots only; never opens a desktop session. Costs a couple of cents.
//   bun run bench:cache
// A. Provider prompt caching (Haiku): the same stable instructions with and without a
//    breakpoint, over distinct screens. Reports cache read/write tokens, cost, latency.
//    DeepSeek is checked for any reported cache usage; nothing is assumed.
// B. Local exact-frame cache: cold call, identical frame again (hit), then one changed
//    pixel (miss). Reports latency, avoided calls, tokens, cost.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../../src/bootstrap/config.ts";
import { createModelRoutes, supportsExplicitCacheBreakpoint } from "../../src/bootstrap/models.ts";
import { ConsoleLogger } from "../../src/adapters/outbound/system/console-logger.ts";
import { SystemClock } from "../../src/adapters/outbound/system/system-clock.ts";
import { OpenRouterClient } from "../../src/adapters/outbound/openrouter/openrouter-client.ts";
import { OpenRouterPerceptionModel, PERCEPTION_PROMPT_FILE } from "../../src/adapters/outbound/openrouter/perception-adapter.ts";
import { loadPromptFile } from "../../src/adapters/outbound/openrouter/prompt-file.ts";
import { createScreenshot, type Screenshot } from "../../src/domain/desktop/screenshot.ts";
import { PerceptionFrameCache, DEFAULT_FRAME_CACHE_ENTRIES, DEFAULT_FRAME_CACHE_TTL_MS } from "../../src/application/perception/frame-cache.ts";
import { PerceiveScreen } from "../../src/application/perception/perceive-screen.ts";
import { addSpend, assertCanSpend, loadLedger, saveLedger } from "./ledger.ts";

const RAW = join(import.meta.dir, "dataset", "raw");
const REPORTS = join(import.meta.dir, "reports");
const LEDGER = join(REPORTS, "ledger.json");
const SCREENS = ["home_clean", "clientes_list", "clientes_crear_form", "r2_cliente_edit"];
const TIMEOUT_MS = 120_000;

async function load(name: string): Promise<Screenshot> {
  const meta = JSON.parse(await readFile(join(RAW, `${name}.json`), "utf8")) as { width: number; height: number; capturedAt: string };
  const rgba = new Uint8Array(await readFile(join(RAW, `${name}.rgba`)));
  return createScreenshot({ observationId: `${name}-${crypto.randomUUID().slice(0, 6)}`, capturedAt: new Date(), width: meta.width, height: meta.height, frameRevision: 1, rgba });
}

interface CallRow {
  readonly label: string;
  readonly screen: string;
  readonly latencyMs: number;
  readonly promptTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly costUsd: number;
  readonly modelCalled: boolean;
}

const sum = (rows: readonly CallRow[], pick: (r: CallRow) => number | null): number => rows.reduce((t, r) => t + (pick(r) ?? 0), 0);

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new ConsoleLogger();
  await mkdir(REPORTS, { recursive: true });
  let ledger = loadLedger(LEDGER);
  assertCanSpend(ledger, 0.05);
  const prompt = loadPromptFile(PERCEPTION_PROMPT_FILE);
  const client = new OpenRouterClient(config.openRouterApiKey);
  const screens = await Promise.all(SCREENS.map(load));
  const callDirect = async (model: OpenRouterPerceptionModel, label: string, screen: Screenshot, name: string): Promise<CallRow> => {
    const started = performance.now();
    const out = await model.call({ observationId: screen.observationId, screenshot: screen, signal: AbortSignal.timeout(TIMEOUT_MS), timeoutMs: TIMEOUT_MS });
    return {
      label, screen: name, latencyMs: Math.round(performance.now() - started),
      promptTokens: out.metadata.promptTokens, cacheReadTokens: out.metadata.cacheReadTokens ?? null,
      cacheWriteTokens: out.metadata.cacheWriteTokens ?? null, costUsd: out.metadata.costUsd ?? 0, modelCalled: true,
    };
  };

  // A. Provider caching. Without breakpoint first, so it cannot benefit from entries the breakpoint run writes.
  const haiku = config.models.perception;
  console.log(`A. provider caching on ${haiku} (breakpoint supported by policy: ${supportsExplicitCacheBreakpoint(haiku)})`);
  const plain = new OpenRouterPerceptionModel(client, haiku, prompt, false);
  const withBreakpoint = new OpenRouterPerceptionModel(client, haiku, prompt, true);
  const withoutRows: CallRow[] = [];
  for (const [i, screen] of screens.entries()) withoutRows.push(await callDirect(plain, "no-breakpoint", screen, SCREENS[i]!));
  const withRows: CallRow[] = [];
  for (const [i, screen] of screens.entries()) withRows.push(await callDirect(withBreakpoint, "breakpoint", screen, SCREENS[i]!));
  const deepseek = new OpenRouterPerceptionModel(client, config.models.perceptionFallback, prompt, false);
  const deepRows: CallRow[] = [];
  for (const i of [0, 0]) deepRows.push(await callDirect(deepseek, "deepseek-repeat", screens[i]!, SCREENS[i]!));

  // B. Local exact-frame cache through the production perception use case.
  console.log("B. local exact-frame cache");
  const routes = createModelRoutes(config, logger);
  const clock = new SystemClock();
  const store = new PerceptionFrameCache({ maxEntries: DEFAULT_FRAME_CACHE_ENTRIES, ttlMs: DEFAULT_FRAME_CACHE_TTL_MS, clock });
  const events: { cache: string | null; cost: number }[] = [];
  const perceive = new PerceiveScreen({
    primary: routes.perception.primary,
    fallback: routes.perception.fallback,
    timeoutMs: TIMEOUT_MS,
    observe: (e) => events.push({ cache: e.localCache ?? null, cost: e.costUsd ?? 0 }),
    cache: { store, version: prompt.version },
  });
  const frameRows: CallRow[] = [];
  const run = async (label: string, screen: Screenshot, name: string): Promise<void> => {
    const before = events.length;
    const started = performance.now();
    const outcome = await perceive.perceive({ taskId: "bench-cache", screenshot: screen, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const latencyMs = Math.round(performance.now() - started);
    if (outcome.status !== "observed") throw new Error(`${name} ${label}: perception abstained (${outcome.reason})`);
    const hit = outcome.cache === "hit";
    frameRows.push({
      label, screen: name, latencyMs, promptTokens: outcome.metadata.promptTokens, cacheReadTokens: outcome.metadata.cacheReadTokens ?? null,
      cacheWriteTokens: outcome.metadata.cacheWriteTokens ?? null, costUsd: outcome.metadata.costUsd ?? 0, modelCalled: !hit,
    });
    void before;
  };
  for (const [i, screen] of screens.entries()) {
    const name = SCREENS[i]!;
    await run("cold", screen, name);
    // A fresh capture of the identical screen: new observation id and time, same pixels.
    await run("warm-identical", { ...screen, observationId: `${screen.observationId}-again`, capturedAt: new Date(), frameRevision: 2 }, name);
    const changed = screen.rgba.slice();
    changed[0] = (changed[0]! + 1) % 256;
    await run("changed-pixel", { ...screen, observationId: `${screen.observationId}-changed`, capturedAt: new Date(), rgba: changed }, name);
  }
  store.clear();

  const cold = frameRows.filter((r) => r.label === "cold");
  const warm = frameRows.filter((r) => r.label === "warm-identical");
  const changedRows = frameRows.filter((r) => r.label === "changed-pixel");
  const mean = (rows: readonly CallRow[]): number => Math.round(rows.reduce((t, r) => t + r.latencyMs, 0) / Math.max(1, rows.length));

  const spent = sum([...withoutRows, ...withRows, ...deepRows, ...frameRows], (r) => r.costUsd);
  ledger = addSpend(ledger, spent, "cache", new Date().toISOString());
  saveLedger(LEDGER, ledger);

  const summary = {
    generatedAt: new Date().toISOString(),
    models: { perception: haiku, fallback: config.models.perceptionFallback },
    prompt: prompt.version,
    providerCache: {
      haiku: {
        withoutBreakpoint: { calls: withoutRows.length, costUsd: sum(withoutRows, (r) => r.costUsd), cacheReadTokens: sum(withoutRows, (r) => r.cacheReadTokens), cacheWriteTokens: sum(withoutRows, (r) => r.cacheWriteTokens), meanLatencyMs: mean(withoutRows) },
        withBreakpoint: { calls: withRows.length, costUsd: sum(withRows, (r) => r.costUsd), cacheReadTokens: sum(withRows, (r) => r.cacheReadTokens), cacheWriteTokens: sum(withRows, (r) => r.cacheWriteTokens), meanLatencyMs: mean(withRows) },
      },
      deepseek: { calls: deepRows.length, reportedCacheReadTokens: deepRows.map((r) => r.cacheReadTokens), reportedCacheWriteTokens: deepRows.map((r) => r.cacheWriteTokens), costs: deepRows.map((r) => r.costUsd) },
    },
    frameCache: {
      screens: SCREENS.length,
      cold: { calls: cold.length, meanLatencyMs: mean(cold), costUsd: sum(cold, (r) => r.costUsd) },
      warmIdentical: { calls: warm.length, modelCalls: warm.filter((r) => r.modelCalled).length, meanLatencyMs: mean(warm), costUsd: sum(warm, (r) => r.costUsd) },
      changedPixel: { calls: changedRows.length, modelCalls: changedRows.filter((r) => r.modelCalled).length, meanLatencyMs: mean(changedRows), costUsd: sum(changedRows, (r) => r.costUsd) },
      avoidedModelCalls: warm.filter((r) => !r.modelCalled).length,
      stats: store.stats,
    },
    spentUsd: spent,
    rows: { withoutRows, withRows, deepRows, frameRows },
  };
  const path = join(REPORTS, `cache-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(path, JSON.stringify(summary, null, 2));

  const p = summary.providerCache.haiku;
  const usd = (v: number) => `US$${v.toFixed(5)}`;
  console.log(`  haiku without breakpoint: cost ${usd(p.withoutBreakpoint.costUsd)}, cacheRead ${p.withoutBreakpoint.cacheReadTokens}, cacheWrite ${p.withoutBreakpoint.cacheWriteTokens}, mean ${p.withoutBreakpoint.meanLatencyMs} ms`);
  console.log(`  haiku with breakpoint:    cost ${usd(p.withBreakpoint.costUsd)}, cacheRead ${p.withBreakpoint.cacheReadTokens}, cacheWrite ${p.withBreakpoint.cacheWriteTokens}, mean ${p.withBreakpoint.meanLatencyMs} ms`);
  for (const r of withRows) console.log(`    ${r.screen.padEnd(22)} prompt=${r.promptTokens} read=${r.cacheReadTokens} write=${r.cacheWriteTokens} cost=${usd(r.costUsd)} ${r.latencyMs} ms`);
  console.log(`  deepseek repeat: reported cache read ${JSON.stringify(summary.providerCache.deepseek.reportedCacheReadTokens)}, write ${JSON.stringify(summary.providerCache.deepseek.reportedCacheWriteTokens)}`);
  const f = summary.frameCache;
  console.log(`  frame cache cold: mean ${f.cold.meanLatencyMs} ms, ${usd(f.cold.costUsd)} | warm identical: mean ${f.warmIdentical.meanLatencyMs} ms, ${f.warmIdentical.modelCalls} model calls, ${usd(f.warmIdentical.costUsd)} | changed pixel: mean ${f.changedPixel.meanLatencyMs} ms, ${f.changedPixel.modelCalls}/${f.changedPixel.calls} model calls`);
  console.log(`  avoided model calls: ${f.avoidedModelCalls}/${f.screens}; stats ${JSON.stringify(f.stats)}`);
  console.log(`  spent ${usd(spent)}; report: ${path}`);
}

await main();
