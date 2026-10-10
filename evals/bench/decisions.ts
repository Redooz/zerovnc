// Phase 3 step 3.6: JEV vs. Luna benchmark. Read-only: it reads captured
// screenshots and never opens a desktop session or sends input.
//   bun run bench:decisions --split development [--freeze]
//   bun run bench:decisions --split held_out          (uses the frozen development calibration)
// Configurations, identical screenshots, intents, labels, and perception evidence:
//   a  perception (Haiku) -> JEV          (text decision over perception candidates)
//   b  perception (Haiku) -> Luna         (same, Luna)
//   c  screenshot with numbered boxes -> Luna (image decision)
// The question offers the candidates plus "none" and "insufficient_evidence" (the intent
// is in the state, which is what the Decisions API reads). The model's own abstentions
// stand; on top of them, a probability threshold and a margin are calibrated on
// development and applied to the chosen candidate. Failed calls are errors, never
// correct abstentions.
// Every latency includes the perception call (its original latency when cached).
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../../src/bootstrap/config.ts";
import { createModelRoutes } from "../../src/bootstrap/models.ts";
import { ConsoleLogger } from "../../src/adapters/outbound/system/console-logger.ts";
import { drawNumberedBoxes } from "../../src/adapters/outbound/artifacts/overlay.ts";
import { encodeRgbaPng } from "../../src/adapters/outbound/artifacts/png-encoder.ts";
import { PERCEPTION_PROMPT_FILE } from "../../src/adapters/outbound/openrouter/perception-adapter.ts";
import { loadPromptFile } from "../../src/adapters/outbound/openrouter/prompt-file.ts";
import { createScreenshot, type Screenshot } from "../../src/domain/desktop/screenshot.ts";
import type { Box, Observation, ObservedElement } from "../../src/domain/perception/observation.ts";
import { PerceiveScreen } from "../../src/application/perception/perceive-screen.ts";
import { CONTROL_CANDIDATE_KINDS, FIELD_CANDIDATE_KINDS, GroundingService, marginOf, type QuestionTemplate } from "../../src/application/grounding/grounding-service.ts";
import { buildNumberedCandidates, resolveNumberedChoice } from "../../src/application/grounding/numbered-candidates.ts";
import type { ModelRoute } from "../../src/application/models/route.ts";
import type { DecisionOutput, DecisionRequest } from "../../src/application/ports/decision-model.ts";
import type { ModelCallEvent } from "../../src/application/ports/model-call-observer.ts";
import { ModelCallError } from "../../src/application/ports/model-call-error.ts";
import { DecisionError, INSUFFICIENT_EVIDENCE } from "../../src/domain/decisions/decision.ts";
import { computeSplitMetrics, selectWinner, type CaseResult, type EvalSplit, type SplitMetrics } from "../components/metrics.ts";
import { applyThreshold, chooseCalibration, sweepGrid, type RawAnswer } from "../components/threshold.ts";
import { createFrozen, frozenMismatches, type FrozenConfig } from "./frozen.ts";
import { addSpend, assertCanSpend, assertHeldOutAllowed, loadLedger, remainingUsd, saveLedger } from "./ledger.ts";
import { cachedPerception, type PerceptionCacheStats } from "./perception-cache.ts";
import { recordDecisions, type DecisionTrace } from "./recording.ts";

const HERE = import.meta.dir;
const RAW = join(HERE, "dataset", "raw");
const PERCEPTION_CACHE = join(HERE, "dataset", "perception-cache");
const REPORTS = join(HERE, "reports");
const LEDGER = join(REPORTS, "ledger.json");
const FROZEN = join(REPORTS, "frozen.json");
const CASES = join(HERE, "cases.json");
const PER_CASE_ESTIMATE_USD = 0.005;
const MODEL_TIMEOUT_MS = 90_000;

interface BenchCase {
  readonly id: string;
  readonly split: EvalSplit;
  // Held-out confirmations are numbered: each round runs once, on screens not used before.
  readonly round?: number;
  readonly screenshot: string;
  readonly field: "control" | "field";
  readonly intent: string;
  readonly expected: { readonly kind: "grounded"; readonly box: Box } | { readonly kind: "abstain"; readonly reason: string };
}

type ConfigName = "a_jev" | "b_luna" | "c_luna_image";
const CONFIG_NAMES: readonly ConfigName[] = ["a_jev", "b_luna", "c_luna_image"];

function parseArgs(argv: readonly string[]): { split: EvalSplit; limit: number; template: QuestionTemplate; freeze: boolean; round: number } {
  let split: EvalSplit = "development";
  let limit = Number.POSITIVE_INFINITY;
  let template: QuestionTemplate = "v1";
  let freeze = false;
  let round = 1;
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    if (argv[i] === "--split") {
      if (value !== "development" && value !== "held_out") throw new Error("--split must be development or held_out");
      split = value;
      i++;
    } else if (argv[i] === "--limit") {
      limit = Number(value);
      i++;
    } else if (argv[i] === "--template") {
      if (value !== "v1" && value !== "v2") throw new Error("--template must be v1 or v2");
      template = value;
      i++;
    } else if (argv[i] === "--freeze") {
      freeze = true;
    } else if (argv[i] === "--round") {
      round = Number(value);
      if (!Number.isInteger(round) || round < 1) throw new Error("--round must be a positive integer");
      i++;
    }
  }
  return { split, limit, template, freeze, round };
}

async function loadScreenshot(name: string): Promise<Screenshot> {
  const meta = JSON.parse(await readFile(join(RAW, `${name}.json`), "utf8")) as { width: number; height: number; capturedAt: string };
  const rgba = new Uint8Array(await readFile(join(RAW, `${name}.rgba`)));
  return createScreenshot({ observationId: name, capturedAt: new Date(meta.capturedAt), width: meta.width, height: meta.height, frameRevision: 1, rgba });
}

function centerInBox(element: ObservedElement, box: Box): boolean {
  const cx = element.box.x + element.box.w / 2;
  const cy = element.box.y + element.box.h / 2;
  return cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h;
}

type CaseBase = Pick<RawAnswer, "caseId" | "split" | "kind" | "expectedGrounded" | "servedFallback">;

function failureRaw(base: CaseBase, failure: string, latencyMs: number, tokens: number, costUsd: number, detail: string | null = null): RawAnswer {
  return { ...base, probability: null, margin: null, inBox: false, failure, chosen: null, detail, latencyMs, tokens, costUsd };
}

interface CaseRaw {
  readonly caseId: string;
  readonly perceived: boolean;
  readonly elements: number;
  // What this case actually cost: perception only on a cache miss, plus each decision call.
  readonly spentUsd: number;
  readonly perceptionCached: boolean;
  readonly raws: Record<ConfigName, RawAnswer>;
  readonly traces: Record<ConfigName, DecisionTrace[]>;
}

interface Runtime {
  readonly routes: ReturnType<typeof createModelRoutes>;
  readonly template: QuestionTemplate;
  readonly cacheStats: PerceptionCacheStats;
  readonly retries: string[];
}

async function runCase(bench: BenchCase, runtime: Runtime): Promise<CaseRaw> {
  const { routes, template } = runtime;
  const screenshot = await loadScreenshot(bench.screenshot);
  const signal = AbortSignal.timeout(MODEL_TIMEOUT_MS * 3);
  const decisionPrompt = loadPromptFile("decision.v1.md");

  const perceptionCalls: ModelCallEvent[] = [];
  const perceive = new PerceiveScreen({
    primary: routes.perception.primary,
    fallback: routes.perception.fallback,
    timeoutMs: MODEL_TIMEOUT_MS,
    observe: (event) => perceptionCalls.push(event),
  });
  const missesBefore = runtime.cacheStats.misses;
  const wallStart = performance.now();
  const perceived = await perceive.perceive({ taskId: bench.id, screenshot, signal });
  const wallMs = performance.now() - wallStart;
  const perceptionCached = runtime.cacheStats.misses === missesBefore;

  const kinds = bench.field === "control" ? CONTROL_CANDIDATE_KINDS : FIELD_CANDIDATE_KINDS;
  const base: CaseBase = {
    caseId: bench.id,
    split: bench.split,
    kind: bench.field === "control" ? "target" : "field",
    expectedGrounded: bench.expected.kind === "grounded",
    servedFallback: false,
  };
  const traces: Record<ConfigName, DecisionTrace[]> = { a_jev: [], b_luna: [], c_luna_image: [] };

  if (perceived.status === "abstained") {
    const cost = perceptionCalls.reduce((t, e) => t + (e.costUsd ?? 0), 0);
    const raw = failureRaw(base, "perception_failed", wallMs, 0, cost, perceived.detail);
    return { caseId: bench.id, perceived: false, elements: 0, spentUsd: cost, perceptionCached, raws: { a_jev: raw, b_luna: raw, c_luna_image: raw }, traces };
  }

  // Original perception latency and cost, whether or not this run paid for them.
  const perceptionMs = perceived.metadata.latencyMs;
  const perceptionCost = perceived.metadata.costUsd ?? 0;
  const perceptionTokens = (perceived.metadata.promptTokens ?? 0) + (perceived.metadata.completionTokens ?? 0);
  const observation: Observation = perceived.observation;
  const targetOf = (element: ObservedElement): boolean => (bench.expected.kind === "grounded" ? centerInBox(element, bench.expected.box) : false);
  let decisionSpend = 0;

  const textRaw = async (name: ConfigName, route: ModelRoute<DecisionRequest, DecisionOutput>): Promise<RawAnswer> => {
    const recorded = recordDecisions(route, traces[name], decisionPrompt);
    const events: ModelCallEvent[] = [];
    const grounding = new GroundingService({
      primary: recorded,
      fallback: recorded,
      timeoutMs: MODEL_TIMEOUT_MS,
      observe: (event) => events.push(event),
      template,
      abstention: { mode: "option" },
    });
    const t0 = performance.now();
    const outcome =
      bench.field === "control"
        ? await grounding.selectControl({ observation, intent: bench.intent, signal })
        : await grounding.selectField({ observation, intent: bench.intent, signal });
    const latencyMs = perceptionMs + (performance.now() - t0);
    const decisionCost = events.reduce((t, e) => t + (e.costUsd ?? 0), 0);
    decisionSpend += decisionCost;
    const tokens = perceptionTokens + events.reduce((t, e) => t + (e.promptTokens ?? 0) + (e.completionTokens ?? 0), 0);
    const costUsd = perceptionCost + decisionCost;
    if (outcome.status === "grounded") {
      return {
        ...base,
        probability: outcome.probability,
        margin: outcome.margin,
        inBox: targetOf(outcome.value),
        failure: null,
        chosen: `${outcome.value.kind} "${outcome.value.label}" @${outcome.value.box.x},${outcome.value.box.y}`,
        detail: outcome.fallbackReason,
        latencyMs,
        tokens,
        costUsd,
        servedFallback: outcome.fallbackReason !== null,
      };
    }
    return failureRaw(base, outcome.reason, latencyMs, tokens, costUsd, outcome.detail);
  };

  const imageRaw = async (): Promise<RawAnswer> => {
    const t0 = performance.now();
    const numbered = buildNumberedCandidates(observation, bench.intent, kinds, bench.field, template);
    if (numbered.status === "abstained") {
      return failureRaw(base, numbered.reason, perceptionMs + (performance.now() - t0), perceptionTokens, perceptionCost);
    }
    const candidates = numbered.candidates;
    const annotated = drawNumberedBoxes(screenshot.width, screenshot.height, screenshot.rgba, candidates.overlay);
    const png = encodeRgbaPng(screenshot.width, screenshot.height, annotated);
    const recorded = recordDecisions(routes.decision.fallback, traces.c_luna_image, decisionPrompt);
    try {
      const out = await recorded.call({ question: candidates.question, evidence: candidates.evidence, image: png, signal, timeoutMs: MODEL_TIMEOUT_MS });
      decisionSpend += out.metadata.costUsd ?? 0;
      const selected = out.answer.kind === "choice" ? out.answer.selected : INSUFFICIENT_EVIDENCE;
      const probabilities = out.answer.kind === "choice" ? out.answer.probabilities : {};
      const probability = probabilities[selected] ?? null;
      const margin = marginOf(probabilities, selected);
      const resolved = resolveNumberedChoice(candidates, selected);
      const latencyMs = perceptionMs + (performance.now() - t0);
      const tokens = perceptionTokens + (out.metadata.promptTokens ?? 0) + (out.metadata.completionTokens ?? 0);
      const costUsd = perceptionCost + (out.metadata.costUsd ?? 0);
      if (resolved.status === "grounded") {
        return {
          ...base,
          probability,
          margin,
          inBox: targetOf(resolved.element),
          failure: null,
          chosen: `${resolved.element.kind} "${resolved.element.label}" @${resolved.element.box.x},${resolved.element.box.y}`,
          detail: null,
          latencyMs,
          tokens,
          costUsd,
        };
      }
      return failureRaw(base, resolved.reason, latencyMs, tokens, costUsd);
    } catch (error) {
      const reason = error instanceof ModelCallError ? `model_${error.kind}` : error instanceof DecisionError ? "invalid_answer" : "unexpected";
      return failureRaw(base, reason, perceptionMs + (performance.now() - t0), perceptionTokens, perceptionCost, error instanceof Error ? error.message : null);
    }
  };

  const raws = {
    a_jev: await textRaw("a_jev", routes.decision.primary),
    b_luna: await textRaw("b_luna", routes.decision.fallback),
    c_luna_image: await imageRaw(),
  };
  return {
    caseId: bench.id,
    perceived: true,
    elements: observation.elements.length,
    spentUsd: (perceptionCached ? 0 : perceptionCost) + decisionSpend,
    perceptionCached,
    raws,
    traces,
  };
}

async function main(): Promise<void> {
  const { split, limit, template, freeze, round } = parseArgs(process.argv.slice(2));
  // Round 1 keeps its original marker name.
  const markerPath = join(REPORTS, round === 1 ? "held-out-confirmed.json" : `held-out-confirmed-r${round}.json`);
  const config = loadConfig();
  const caseText = await readFile(CASES, "utf8");
  const datasetHash = createHash("sha256").update(caseText).digest("hex").slice(0, 16);
  const setup = {
    datasetHash,
    models: { ...config.models } as Record<string, string>,
    prompts: { perception: loadPromptFile(PERCEPTION_PROMPT_FILE).version, decision: loadPromptFile("decision.v1.md").version, questionTemplate: template } as Record<string, string>,
  };

  let frozen: FrozenConfig | null = null;
  if (split === "held_out") {
    assertHeldOutAllowed(markerPath);
    if (!existsSync(FROZEN)) throw new Error("held-out needs a frozen development calibration: run development with --freeze first");
    frozen = JSON.parse(await readFile(FROZEN, "utf8")) as FrozenConfig;
    const problems = frozenMismatches(frozen, setup);
    if (problems.length > 0) throw new Error(`held-out refused, setup changed since the freeze:\n  - ${problems.join("\n  - ")}`);
  }
  if (freeze && (split !== "development" || Number.isFinite(limit))) throw new Error("--freeze needs the full development split");

  const selected = (JSON.parse(caseText) as { cases: readonly BenchCase[] }).cases.filter((c) => c.split === split && (split !== "held_out" || (c.round ?? 1) === round)).slice(0, limit);
  if (selected.length === 0) throw new Error(`no cases in split ${split}`);

  const retries: string[] = [];
  const baseRoutes = createModelRoutes(config, new ConsoleLogger(), {
    retry: { onRetry: (info) => retries.push(`${info.model} attempt ${info.attempt}: ${info.reason}`) },
  });
  const cacheStats: PerceptionCacheStats = { hits: 0, misses: 0 };
  const salt = `${loadPromptFile(PERCEPTION_PROMPT_FILE).version}|${createHash("sha256").update(loadPromptFile(PERCEPTION_PROMPT_FILE).text).digest("hex").slice(0, 12)}`;
  const routes = {
    ...baseRoutes,
    perception: {
      primary: cachedPerception(baseRoutes.perception.primary, PERCEPTION_CACHE, salt, cacheStats),
      fallback: cachedPerception(baseRoutes.perception.fallback, PERCEPTION_CACHE, salt, cacheStats),
    },
  };
  await mkdir(REPORTS, { recursive: true });

  let ledger = loadLedger(LEDGER);
  const cases: CaseRaw[] = [];
  const runtime: Runtime = { routes, template, cacheStats, retries };
  for (const bench of selected) {
    assertCanSpend(ledger, PER_CASE_ESTIMATE_USD);
    const run = await runCase(bench, runtime);
    cases.push(run);
    ledger = addSpend(ledger, run.spentUsd, split, new Date().toISOString());
    saveLedger(LEDGER, ledger);
    console.log(`${bench.id.padEnd(30)} perceived=${run.perceived} cached=${run.perceptionCached} elements=${run.elements} remaining US$${remainingUsd(ledger).toFixed(4)}`);
  }

  const rawsOf = (name: ConfigName): RawAnswer[] => cases.map((c) => c.raws[name]);
  const calibration: Record<string, { threshold: number; minMargin: number }> = {};
  for (const name of CONFIG_NAMES) {
    if (frozen !== null) {
      const fixed = frozen.calibration[name];
      if (fixed === undefined) throw new Error(`frozen calibration has no entry for ${name}`);
      calibration[name] = fixed;
    } else {
      const chosen = chooseCalibration(rawsOf(name));
      calibration[name] = { threshold: chosen.threshold, minMargin: chosen.minMargin };
    }
  }

  const results = {} as Record<ConfigName, CaseResult[]>;
  const metrics = {} as Record<ConfigName, SplitMetrics>;
  for (const name of CONFIG_NAMES) {
    const { threshold, minMargin } = calibration[name]!;
    results[name] = rawsOf(name).map((raw) => applyThreshold(raw, threshold, minMargin));
    // Score the split that was run: held-out results are never read from the development bucket.
    metrics[name] = computeSplitMetrics(results[name]);
  }
  const summaries = CONFIG_NAMES.map((name) => ({ name, metrics: metrics[name] }));
  const winner = selectWinner(summaries);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const report = {
    generatedAt: new Date().toISOString(),
    split,
    ...setup,
    round: split === "held_out" ? round : null,
    abstention: { mode: "option plus calibrated gate", calibration, source: frozen === null ? "chosen on development: highest accuracy, ties to most conservative" : `frozen at ${frozen.frozenAt}` },
    sweep: Object.fromEntries(CONFIG_NAMES.map((name) => [name, sweepGrid(rawsOf(name))])),
    configs: summaries,
    winner: winner?.name ?? null,
    selectionRule: "eligible if accuracy >= 0.8, error rate <= 0.1, wrong-grounding rate <= 0.1; then fastest p50 within 0.05 of the best",
    perceptionCache: cacheStats,
    retries,
    cases: cases.map((c) => ({ id: c.caseId, perceived: c.perceived, perceptionCached: c.perceptionCached, elements: c.elements, spentUsd: c.spentUsd })),
    raw: Object.fromEntries(CONFIG_NAMES.map((name) => [name, rawsOf(name)])),
    decisionTraces: Object.fromEntries(cases.map((c) => [c.caseId, c.traces])),
    results,
  };
  const reportPath = join(REPORTS, `bench-${split}-${stamp}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2));

  const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(0)}%`);
  for (const s of summaries) {
    const m = s.metrics;
    const c = calibration[s.name]!;
    console.log(
      `${s.name.padEnd(14)} t=${c.threshold} m=${c.minMargin} acc=${pct(m.decisionAccuracy)} recall=${pct(m.targetRecall)} precision=${pct(m.groundingPrecision)} abstain=${pct(m.abstentionCorrectness)} errors=${pct(m.errorRate)} wrong=${pct(m.wrongGroundingRate)} p50=${Math.round(m.latencyP50Ms)}ms p95=${Math.round(m.latencyP95Ms)}ms`,
    );
  }
  console.log(winner === null ? "winner: none (no configuration meets the correctness floors)" : `winner: ${winner.name}`);
  console.log(`retries: ${retries.length}, perception cache: ${cacheStats.hits} hits / ${cacheStats.misses} misses`);
  console.log(`report: ${reportPath}`);

  if (freeze) {
    const frozenConfig = createFrozen(setup, calibration, new Date().toISOString());
    await writeFile(FROZEN, JSON.stringify(frozenConfig, null, 2));
    console.log(`frozen calibration: ${FROZEN}`);
  }
  if (split === "held_out") {
    await writeFile(markerPath, JSON.stringify({ confirmedAt: new Date().toISOString(), round, calibration, report: reportPath }, null, 2));
  }
}

await main();
