// Phase 4 benchmark: does perception mark disabled controls correctly? Read-only: it reads
// captured screenshots and never opens a desktop session or sends input.
//   bun run evals/bench/state.ts --split development
//   bun run evals/bench/state.ts --split held_out      (runs once; marker file)
// Per screen, compares the elements perception flagged as disabled with the labelled list.
//   recall      flagged expected-disabled controls / expected-disabled controls
//   false flags flagged controls that are not in an exhaustive list
// Screens whose list is not exhaustive only report their flags, for manual review.
// Uses the same on-disk perception cache as bench:decisions, so a screen is perceived once
// per prompt version.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../../src/bootstrap/config.ts";
import { createModelRoutes } from "../../src/bootstrap/models.ts";
import { ConsoleLogger } from "../../src/adapters/outbound/system/console-logger.ts";
import { PERCEPTION_PROMPT_FILE } from "../../src/adapters/outbound/openrouter/perception-adapter.ts";
import { loadPromptFile } from "../../src/adapters/outbound/openrouter/prompt-file.ts";
import { createHash } from "node:crypto";
import { createScreenshot, type Screenshot } from "../../src/domain/desktop/screenshot.ts";
import { PerceiveScreen } from "../../src/application/perception/perceive-screen.ts";
import { addSpend, assertCanSpend, assertHeldOutAllowed, loadLedger, saveLedger } from "./ledger.ts";
import { cachedPerception, type PerceptionCacheStats } from "./perception-cache.ts";

const HERE = import.meta.dir;
const RAW = join(HERE, "dataset", "raw");
const PERCEPTION_CACHE = join(HERE, "dataset", "perception-cache");
const REPORTS = join(HERE, "reports");
const LEDGER = join(REPORTS, "ledger.json");
const PERCEPTION_FILE = process.env.BENCH_PERCEPTION_PROMPT ?? PERCEPTION_PROMPT_FILE;
const CONTROL_KINDS = new Set(["button", "link", "tab", "menu_item", "icon_button", "checkbox", "dropdown", "text_field", "date_field"]);

interface StateCase {
  readonly id: string;
  readonly split: "development" | "held_out";
  readonly screenshot: string;
  readonly disabled: readonly string[];
  readonly exhaustive: boolean;
}

interface CaseReport {
  readonly id: string;
  readonly split: string;
  readonly exhaustive: boolean;
  readonly expected: readonly string[];
  readonly flagged: readonly string[];
  readonly missed: readonly string[];
  readonly falseFlags: readonly string[];
  readonly perceptionMs: number | null;
  readonly completionTokens: number | null;
  readonly elements: number;
  readonly cached: boolean;
}

async function load(name: string): Promise<Screenshot> {
  const meta = JSON.parse(await readFile(join(RAW, `${name}.json`), "utf8")) as { width: number; height: number; capturedAt: string };
  const rgba = new Uint8Array(await readFile(join(RAW, `${name}.rgba`)));
  return createScreenshot({ observationId: name, capturedAt: new Date(meta.capturedAt), width: meta.width, height: meta.height, frameRevision: 1, rgba });
}

const norm = (text: string): string => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();

async function main(): Promise<void> {
  const splitArg = process.argv[process.argv.indexOf("--split") + 1];
  if (splitArg !== "development" && splitArg !== "held_out") throw new Error("--split must be development or held_out");
  const marker = join(REPORTS, "state-held-out-confirmed.json");
  if (splitArg === "held_out") assertHeldOutAllowed(marker);

  const config = loadConfig();
  const cases = (JSON.parse(await readFile(join(HERE, "state-cases.json"), "utf8")) as { cases: StateCase[] }).cases.filter((c) => c.split === splitArg);
  const prompt = loadPromptFile(PERCEPTION_FILE);
  const base = createModelRoutes(config, new ConsoleLogger(), { perceptionPromptFile: PERCEPTION_FILE });
  const stats: PerceptionCacheStats = { hits: 0, misses: 0 };
  const salt = `${prompt.version}|${createHash("sha256").update(prompt.text).digest("hex").slice(0, 12)}`;
  const perceive = new PerceiveScreen({
    primary: cachedPerception(base.perception.primary, PERCEPTION_CACHE, salt, stats),
    fallback: cachedPerception(base.perception.fallback, PERCEPTION_CACHE, salt, stats),
    timeoutMs: 90_000,
  });
  await mkdir(REPORTS, { recursive: true });
  let ledger = loadLedger(LEDGER);

  const reports: CaseReport[] = [];
  for (const c of cases) {
    assertCanSpend(ledger, 0.005);
    const missesBefore = stats.misses;
    const outcome = await perceive.perceive({ taskId: c.id, screenshot: await load(c.screenshot), signal: AbortSignal.timeout(300_000) });
    const cached = stats.misses === missesBefore;
    if (outcome.status !== "observed") {
      console.log(`${c.id.padEnd(30)} perception abstained: ${outcome.reason}`);
      reports.push({ id: c.id, split: c.split, exhaustive: c.exhaustive, expected: c.disabled, flagged: [], missed: [...c.disabled], falseFlags: [], perceptionMs: null, completionTokens: null, elements: 0, cached });
      continue;
    }
    if (!cached) {
      ledger = addSpend(ledger, outcome.metadata.costUsd ?? 0, `state-${splitArg}`, new Date().toISOString());
      saveLedger(LEDGER, ledger);
    }
    const controls = outcome.observation.elements.filter((e) => e.visible && CONTROL_KINDS.has(e.kind));
    const flagged = controls.filter((e) => e.disabled === true).map((e) => e.label);
    const expected = new Set(c.disabled.map(norm));
    const flaggedSet = new Set(flagged.map(norm));
    const missed = c.disabled.filter((label) => !flaggedSet.has(norm(label)));
    const falseFlags = flagged.filter((label) => !expected.has(norm(label)));
    reports.push({
      id: c.id,
      split: c.split,
      exhaustive: c.exhaustive,
      expected: c.disabled,
      flagged,
      missed,
      falseFlags,
      perceptionMs: outcome.metadata.latencyMs,
      completionTokens: outcome.metadata.completionTokens,
      elements: outcome.observation.elements.length,
      cached,
    });
    const verdict = missed.length === 0 && (!c.exhaustive || falseFlags.length === 0) ? "ok" : "MISMATCH";
    console.log(`${c.id.padEnd(30)} ${verdict.padEnd(8)} flagged=[${flagged.join(", ")}] expected=[${c.disabled.join(", ")}] cached=${cached}`);
  }

  const labelled = reports.filter((r) => r.exhaustive);
  const expectedTotal = labelled.reduce((t, r) => t + r.expected.length, 0);
  const missedTotal = labelled.reduce((t, r) => t + r.missed.length, 0);
  const falseTotal = labelled.reduce((t, r) => t + r.falseFlags.length, 0);
  const review = reports.filter((r) => !r.exhaustive && r.flagged.length > 0).map((r) => ({ id: r.id, flagged: r.flagged }));
  const summary = {
    promptVersion: prompt.version,
    split: splitArg,
    labelledScreens: labelled.length,
    expectedDisabled: expectedTotal,
    recall: expectedTotal === 0 ? null : (expectedTotal - missedTotal) / expectedTotal,
    falseFlags: falseTotal,
    screensWithAnyMismatch: labelled.filter((r) => r.missed.length > 0 || r.falseFlags.length > 0).map((r) => r.id),
    flagsToReviewOnUnlabelledScreens: review,
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(REPORTS, `state-${splitArg}-${prompt.version}-${stamp}.json`);
  await writeFile(file, JSON.stringify({ summary, cases: reports }, null, 2));
  if (splitArg === "held_out") await writeFile(marker, JSON.stringify({ confirmedAt: new Date().toISOString(), report: file }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log(`report: ${file}`);
}

if (import.meta.main && !existsSync(join(HERE, "state-cases.json"))) throw new Error("missing state-cases.json");
if (import.meta.main) await main();
