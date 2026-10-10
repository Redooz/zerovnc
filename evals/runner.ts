// Evaluation runner. Feeds practice tasks through the public agent API, grades
// the outcome and app state, and writes a machine-readable report.
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadPracticeFixtures, toAgentSubmission, type LoadedFixture } from "./fixtures.ts";
import { gradeRun, type AgentOutcome, type GradedRun } from "./graders/index.ts";
import type { AppStateEvidence } from "./graders/app-state.ts";
import type { CheckResult, Verdict } from "./graders/result.ts";
import type { AgentClient, DesktopControl } from "./ports.ts";
import { HttpAgentClient } from "./adapters/http-agent-client.ts";
import { HttpDesktopControl } from "./adapters/http-desktop-control.ts";

export const CHALLENGE_TASK_LIMIT_MS = 5 * 60_000;
export const CHALLENGE_POLL_MS = 5_000;

export interface DesktopAccess {
  readonly url: string;
  readonly password: string;
}

export interface EvalOptions {
  readonly fixtures: readonly LoadedFixture[];
  readonly agent: AgentClient;
  // null means no desktop control: resets are skipped and app state is "not evaluated".
  readonly desktop: DesktopControl | null;
  readonly access: DesktopAccess;
  readonly secrets: readonly string[];
  readonly pollIntervalMs?: number;
  readonly deadlineMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export interface RunReport {
  readonly id: string;
  readonly nivel: string;
  readonly file: string;
  readonly taskId: string | null;
  readonly expectedStatus: string;
  readonly actualStatus: string;
  readonly elapsedMs: number;
  readonly timedOut: boolean;
  readonly verdict: Verdict;
  readonly checks: readonly CheckResult[];
  readonly summary: string;
}

export interface EvalReport {
  readonly generatedAt: string;
  readonly counts: Record<Verdict, number>;
  readonly runs: readonly RunReport[];
}

export async function runEvaluation(options: EvalOptions): Promise<EvalReport> {
  const pollIntervalMs = options.pollIntervalMs ?? CHALLENGE_POLL_MS;
  const deadlineMs = options.deadlineMs ?? CHALLENGE_TASK_LIMIT_MS;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = options.now ?? (() => Date.now());

  const runs: RunReport[] = [];
  for (const loaded of options.fixtures) {
    runs.push(await runOne(loaded, options, { pollIntervalMs, deadlineMs, sleep, now }));
  }
  const counts: Record<Verdict, number> = { pass: 0, fail: 0, not_evaluated: 0 };
  for (const run of runs) counts[run.verdict] += 1;
  return { generatedAt: new Date().toISOString(), counts, runs };
}

interface Timing {
  readonly pollIntervalMs: number;
  readonly deadlineMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

async function runOne(loaded: LoadedFixture, options: EvalOptions, timing: Timing): Promise<RunReport> {
  const { fixture } = loaded;
  const base = { id: fixture.id, nivel: fixture.nivel, file: loaded.file, expectedStatus: fixture.estado_esperado };

  // Reset first so each task starts from the practice data. The five-minute
  // limit starts after the reset, matching the evaluator's own clock. If the
  // reset fails the desktop state is unknown, so the task is not sent.
  if (options.desktop !== null) {
    try {
      await options.desktop.reset();
    } catch (error) {
      return notRun(base, `desktop reset failed: ${describe(error)}`, timing.now(), timing);
    }
  }
  const started = timing.now();

  let taskId: string;
  try {
    taskId = await options.agent.submit(toAgentSubmission(fixture, options.access));
  } catch (error) {
    return finish(base, { taskId: null, outcome: { estado: "no_aceptada", resumen: describe(error) },
      started, timing, timedOut: false, options, loaded,
      evidence: { kind: "unavailable", reason: "task was not accepted" } });
  }

  // Poll like the evaluator: every interval, until terminal or the 5-minute limit.
  let outcome: AgentOutcome | null = null;
  let timedOut = false;
  for (;;) {
    let current: AgentOutcome | null = null;
    try {
      current = await options.agent.poll(taskId);
    } catch {
      // Transient poll errors are retried until the deadline.
    }
    // The deadline is checked before a terminal result is accepted. A result
    // that arrives after the limit does not count: the task ran out of time.
    if (timing.now() - started >= timing.deadlineMs) {
      timedOut = true;
      break;
    }
    if (current !== null && current.estado !== "en_curso") {
      outcome = current;
      break;
    }
    // Never sleep past the task limit: a late sleep would delay the timeout verdict.
    const remaining = timing.deadlineMs - (timing.now() - started);
    await timing.sleep(Math.min(timing.pollIntervalMs, Math.max(0, remaining)));
  }

  const evidence: AppStateEvidence =
    options.desktop === null
      ? { kind: "unavailable", reason: "no desktop checker configured" }
      : await options.desktop.check(loaded.raw);

  return finish(base, { taskId, outcome, started, timing, timedOut, options, loaded, evidence });
}

// A task that was never sent to the agent. Nothing ran, so there is no status to
// grade; the run is recorded as not evaluated.
function notRun(
  base: { id: string; nivel: string; file: string; expectedStatus: string },
  reason: string,
  started: number,
  timing: Timing,
): RunReport {
  return {
    ...base,
    taskId: null,
    actualStatus: "sin_ejecutar",
    elapsedMs: timing.now() - started,
    timedOut: false,
    verdict: "not_evaluated",
    checks: [{ name: "ejecucion", outcome: "not_evaluated", detail: reason }],
    summary: "",
  };
}

interface FinishInput {
  readonly taskId: string | null;
  readonly outcome: AgentOutcome | null;
  readonly started: number;
  readonly timing: Timing;
  readonly timedOut: boolean;
  readonly options: EvalOptions;
  readonly loaded: LoadedFixture;
  readonly evidence: AppStateEvidence;
}

function finish(base: { id: string; nivel: string; file: string; expectedStatus: string }, input: FinishInput): RunReport {
  // A run without a terminal outcome is graded as the agent reporting nothing.
  const outcome: AgentOutcome = input.outcome ?? { estado: "sin_terminar", resumen: "" };
  const graded: GradedRun = gradeRun(input.loaded.fixture, outcome, input.evidence, input.options.secrets);
  return {
    ...base,
    taskId: input.taskId,
    actualStatus: outcome.estado,
    elapsedMs: input.timing.now() - input.started,
    timedOut: input.timedOut,
    verdict: graded.verdict,
    // Details can quote the agent's summary, so they are redacted as well.
    checks: graded.checks.map((check) => ({
      ...check,
      detail: redact(check.detail, input.options.secrets),
    })),
    summary: redact(outcome.resumen, input.options.secrets),
  };
}

// Removes secret values from anything written to a report.
export function redact(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length > 0) result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

// ---- CLI ----

function requireEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const env = process.env;
  const fixturesDir = resolve(env.EVAL_FIXTURES_DIR ?? "../frontier-reto-1/pruebas");
  const reportDir = resolve(env.EVAL_REPORT_DIR ?? "./reports");
  const agentUrl = requireEnv(env, "EVAL_AGENT_URL");
  const agentToken = requireEnv(env, "EVAL_AGENT_TOKEN");
  const access: DesktopAccess = {
    url: requireEnv(env, "EVAL_DESKTOP_URL"),
    password: requireEnv(env, "EVAL_DESKTOP_PASSWORD"),
  };
  const checkUrl = env.EVAL_DESKTOP_CHECK_URL?.trim();
  const checkToken = env.EVAL_DESKTOP_CHECK_TOKEN?.trim();
  const desktop: DesktopControl | null =
    checkUrl && checkToken ? new HttpDesktopControl(checkUrl, checkToken) : null;

  const secrets = [access.password, agentToken, checkToken ?? ""].filter((s) => s.length > 0);
  const report = await runEvaluation({
    fixtures: await loadPracticeFixtures(fixturesDir),
    agent: new HttpAgentClient(agentUrl, agentToken),
    desktop,
    access,
    secrets,
  });

  await mkdir(reportDir, { recursive: true });
  const file = join(reportDir, `eval-${report.generatedAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(file, JSON.stringify(report, null, 2));
  for (const run of report.runs) {
    console.log(`${run.id} ${run.verdict.toUpperCase()} expected=${run.expectedStatus} actual=${run.actualStatus}`);
  }
  console.log(`report: ${file}`);
  process.exit(report.counts.pass === report.runs.length ? 0 : 1);
}

if (import.meta.main) {
  await main();
}
