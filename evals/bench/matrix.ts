// Decision-only matrix: isolates the decision step from perception. Observations are
// built by hand with correct captions, relations, and boxes, so any wrong answer is the
// decision integration's fault, not perception's. Each case runs three ways (base,
// reversed candidate order, renamed ids): a correct answer must follow the evidence, not
// the position or the identifier. Costs a few cents; never opens a desktop session.
//   bun run bench:matrix
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../../src/bootstrap/config.ts";
import { createModelRoutes } from "../../src/bootstrap/models.ts";
import { ConsoleLogger } from "../../src/adapters/outbound/system/console-logger.ts";
import { loadPromptFile } from "../../src/adapters/outbound/openrouter/prompt-file.ts";
import { CONTROL_CANDIDATE_KINDS, FIELD_CANDIDATE_KINDS, GroundingService, labelTextFor } from "../../src/application/grounding/grounding-service.ts";
import type { ModelRoute } from "../../src/application/models/route.ts";
import type { DecisionOutput, DecisionRequest } from "../../src/application/ports/decision-model.ts";
import { createObservation, type ElementRelation, type Observation, type ObservedElement } from "../../src/domain/perception/observation.ts";
import { summarizeMatrix, type MatrixRow } from "./matrix-score.ts";
import { addSpend, assertCanSpend, loadLedger, saveLedger } from "./ledger.ts";
import { recordDecisions, type DecisionTrace } from "./recording.ts";

const REPORTS = join(import.meta.dir, "reports");
const LEDGER = join(REPORTS, "ledger.json");
const NOT_APPLICABLE = { state: "not_applicable" } as const;

const button = (id: string, label: string, x: number): ObservedElement => ({ id, label, kind: "button", value: NOT_APPLICABLE, box: { x, y: 700, w: 90, h: 30 }, visible: true });
const caption = (id: string, label: string, y: number): ObservedElement => ({ id, label, kind: "label", value: NOT_APPLICABLE, box: { x: 30, y, w: 120, h: 18 }, visible: true });
const field = (id: string, y: number): ObservedElement => ({ id, label: "", kind: "text_field", value: { state: "empty" }, box: { x: 30, y: y + 20, w: 400, h: 24 }, visible: true });
const heading = (id: string, label: string): ObservedElement => ({ id, label, kind: "text", value: NOT_APPLICABLE, box: { x: 30, y: 30, w: 300, h: 24 }, visible: true });

function observe(elements: ObservedElement[], relations: ElementRelation[] = []): Observation {
  return createObservation({ id: "matrix", taskId: "matrix", capturedAt: new Date(0), width: 1280, height: 800, frameRevision: 1, screenshotRef: null, elements, relations });
}

interface MatrixCase {
  readonly id: string;
  readonly field: "control" | "field";
  readonly intent: string;
  readonly observation: Observation;
  readonly expected: MatrixRow["expected"];
}

const BUTTONS = [heading("h", "Crear cliente"), button("b1", "Guardar", 100), button("b2", "Cancelar", 200), button("b3", "Exportar", 300)];
const FORM = [
  heading("h", "Crear cliente"),
  caption("c1", "Razón social o nombre *", 80), field("f1", 80),
  caption("c2", "NIT *", 140), field("f2", 140),
  caption("c3", "Teléfono *", 200), field("f3", 200),
  caption("c4", "Correo", 260), field("f4", 260),
];
const FORM_RELATIONS: ElementRelation[] = [
  { kind: "labels", from: "c1", to: "f1" }, { kind: "labels", from: "c2", to: "f2" },
  { kind: "labels", from: "c3", to: "f3" }, { kind: "labels", from: "c4", to: "f4" },
];

const CASES: readonly MatrixCase[] = [
  { id: "ctl-guardar", field: "control", intent: "Guardar", observation: observe(BUTTONS), expected: { kind: "choose", label: "Guardar" } },
  { id: "ctl-cancelar", field: "control", intent: "Cancelar", observation: observe(BUTTONS), expected: { kind: "choose", label: "Cancelar" } },
  { id: "ctl-exportar", field: "control", intent: "Exportar", observation: observe(BUTTONS), expected: { kind: "choose", label: "Exportar" } },
  { id: "ctl-eliminar-absent", field: "control", intent: "Eliminar", observation: observe(BUTTONS), expected: { kind: "abstain" } },
  { id: "ctl-guardar-duplicated", field: "control", intent: "Guardar", observation: observe([heading("h", "Crear cliente"), button("b1", "Guardar", 100), button("b2", "Guardar", 250), button("b3", "Cancelar", 400)]), expected: { kind: "abstain" } },
  { id: "fld-nit", field: "field", intent: "campo NIT", observation: observe(FORM, FORM_RELATIONS), expected: { kind: "choose", label: "NIT *" } },
  { id: "fld-telefono", field: "field", intent: "campo Teléfono", observation: observe(FORM, FORM_RELATIONS), expected: { kind: "choose", label: "Teléfono *" } },
  { id: "fld-direccion-absent", field: "field", intent: "campo Dirección", observation: observe(FORM, FORM_RELATIONS), expected: { kind: "abstain" } },
];

// Variants must not change the right answer.
function reversed(o: Observation): Observation {
  return observe([...o.elements].reverse(), [...o.relations].reverse());
}
function renamed(o: Observation): Observation {
  const map = new Map(o.elements.map((e, i) => [e.id, `z${(i * 7 + 3) % 97}x${i}`]));
  return observe(
    o.elements.map((e) => ({ ...e, id: map.get(e.id)! })),
    o.relations.map((r) => ({ ...r, from: map.get(r.from)!, to: map.get(r.to)! })),
  );
}

// A candidate's name for scoring: its label, or its caption when it has no label of its own.
function nameOf(observation: Observation, element: ObservedElement): string {
  return element.label.trim() !== "" ? element.label : (labelTextFor(observation, element) ?? "(unnamed)");
}

async function main(): Promise<void> {
  const config = loadConfig();
  const routes = createModelRoutes(config, new ConsoleLogger());
  const prompt = loadPromptFile("decision.v1.md");
  const models: [string, ModelRoute<DecisionRequest, DecisionOutput>][] = [
    [config.models.decision, routes.decision.primary],
    [config.models.decisionFallback, routes.decision.fallback],
  ];
  const variants = [["base", (o: Observation) => o], ["reversed", reversed], ["renamed", renamed]] as const;
  const modes = ["threshold", "option"] as const;

  await mkdir(REPORTS, { recursive: true });
  let ledger = loadLedger(LEDGER);
  const rows: MatrixRow[] = [];
  const traces: Array<{ key: string; traces: DecisionTrace[] }> = [];
  const signal = AbortSignal.timeout(15 * 60_000);

  for (const [model, route] of models) {
    for (const mode of modes) {
      for (const testCase of CASES) {
        for (const [variant, transform] of variants) {
          assertCanSpend(ledger, 0.001);
          const observation = transform(testCase.observation);
          const sink: DecisionTrace[] = [];
          const recorded = recordDecisions(route, sink, prompt);
          const grounding = new GroundingService({
            primary: recorded,
            fallback: recorded,
            timeoutMs: 60_000,
            abstention: mode === "threshold" ? { mode: "threshold", threshold: 0 } : { mode: "option" },
          });
          const kinds = testCase.field === "control" ? CONTROL_CANDIDATE_KINDS : FIELD_CANDIDATE_KINDS;
          void kinds;
          const outcome =
            testCase.field === "control"
              ? await grounding.selectControl({ observation, intent: testCase.intent, signal })
              : await grounding.selectField({ observation, intent: testCase.intent, signal });
          let result: MatrixRow["outcome"];
          if (outcome.status === "grounded") {
            result = { kind: "chose", label: nameOf(observation, outcome.value), probability: outcome.probability, margin: outcome.margin };
          } else if (outcome.reason === "model_failed" || outcome.reason === "invalid_answer") {
            result = { kind: "error", reason: `${outcome.reason}: ${outcome.detail}` };
          } else {
            result = { kind: "abstained", reason: outcome.reason };
          }
          rows.push({ model, mode, caseId: testCase.id, variant, expected: testCase.expected, outcome: result });
          traces.push({ key: `${model}|${mode}|${testCase.id}|${variant}`, traces: sink });
          const cost = sink.reduce((t, x) => t + (x.result.status === "ok" ? 0.00002 : 0), 0);
          ledger = addSpend(ledger, cost, "matrix", new Date().toISOString());
        }
      }
    }
  }
  saveLedger(LEDGER, ledger);

  const summaries = summarizeMatrix(rows);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(REPORTS, `matrix-${stamp}.json`);
  await writeFile(path, JSON.stringify({ generatedAt: new Date().toISOString(), models: config.models, prompt: prompt.version, summaries, rows, traces }, null, 2));

  const f = (v: number | null) => (v === null ? "n/a" : v.toFixed(2));
  for (const s of summaries) {
    console.log(
      `${s.model.padEnd(30)} ${s.mode.padEnd(9)} correct=${s.correct}/${s.rows} wrongChoice=${s.wrongChoice} wrongAbstain=${s.wrongAbstention} errors=${s.errors} unstable=[${s.unstableCases.join(",")}] correctMinP=${f(s.lowestCorrectProbability)} wrongMaxP=${f(s.highestWrongProbability)} sepP=${s.separableByProbability} sepM=${s.separableByMargin}`,
    );
  }
  console.log(`report: ${path}`);
}

await main();
