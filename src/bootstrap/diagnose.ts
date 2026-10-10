// Live Phase 3 diagnostic: capture one real screen, perceive it, ask one bounded
// question, print a timeline and the spend. Read-only on the desktop: it never sends
// pointer or keyboard input. Usage: bun run diagnose "<intent>"
// Reads EVAL_DESKTOP_URL / EVAL_DESKTOP_PASSWORD and the model/OpenRouter settings from .env.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encodeRgbaPng } from "../adapters/outbound/artifacts/png-encoder.ts";
import { loadConfig, ConfigError } from "./config.ts";
import { createModelRoutes } from "./models.ts";
import { ConsoleLogger } from "../adapters/outbound/system/console-logger.ts";
import { VncDesktopSessionFactory } from "../adapters/outbound/vnc/vnc-desktop-session.ts";
import { SystemClock } from "../adapters/outbound/system/system-clock.ts";
import { PerceiveScreen } from "../application/perception/perceive-screen.ts";
import { GroundingService } from "../application/grounding/grounding-service.ts";
import type { TaskId } from "../domain/tasks/task.ts";
import { DesktopError } from "../domain/desktop/errors.ts";
import type { ModelCallEvent } from "../application/ports/model-call-observer.ts";

const DIAGNOSTIC_TIMEOUT_MS = 60_000;

interface TimelineEntry {
  readonly at: string;
  readonly step: string;
  readonly detail: string;
  readonly costUsd: number | null;
}

async function main(): Promise<void> {
  const logger = new ConsoleLogger();
  const intent = process.argv.slice(2).join(" ").trim();
  if (intent === "") {
    console.error('usage: bun run diagnose "<intent, e.g. the save button>"');
    process.exit(2);
  }
  const url = process.env.EVAL_DESKTOP_URL;
  const password = process.env.EVAL_DESKTOP_PASSWORD;
  if (!url || !password) {
    console.error("set EVAL_DESKTOP_URL and EVAL_DESKTOP_PASSWORD (see .env.example)");
    process.exit(2);
  }

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      for (const issue of error.issues) console.error(`  - ${issue}`);
    }
    process.exit(1);
  }

  const clock = new SystemClock();
  const timeline: TimelineEntry[] = [];
  const record = (step: string, detail: string, costUsd: number | null = null): void => {
    timeline.push({ at: new Date().toISOString(), step, detail, costUsd });
  };
  const secrets = [password, config.openRouterApiKey, config.bearerToken];
  const scrub = (text: string): string => secrets.reduce((acc, s) => acc.split(s).join("[REDACTED]"), text);

  const observe = (event: ModelCallEvent): void => {
    const detail =
      event.outcome === "ok"
        ? `${event.role} ${event.questionId ?? ""} served by ${event.servedBy}, prompt ${event.promptVersion}, fallback ${event.fallbackReason ?? "none"}, ${event.latencyMs} ms, observation ${event.observationId}`
        : `${event.role} ${event.questionId ?? ""} failed: ${event.failure}, observation ${event.observationId}`;
    record("model", detail, event.costUsd);
  };

  const routes = createModelRoutes(config, logger);
  const perception = new PerceiveScreen({
    primary: routes.perception.primary,
    fallback: routes.perception.fallback,
    timeoutMs: DIAGNOSTIC_TIMEOUT_MS,
    observe,
  });
  const grounding = new GroundingService({
    primary: routes.decision.primary,
    fallback: routes.decision.fallback,
    timeoutMs: DIAGNOSTIC_TIMEOUT_MS,
    observe,
  });

  const signal = AbortSignal.timeout(DIAGNOSTIC_TIMEOUT_MS * 2);
  const sessions = new VncDesktopSessionFactory(clock);
  let session;
  try {
    session = await sessions.connect({ url, password }, signal);
  } catch (error) {
    // Report the failure kind only; the URL and password are never printed.
    const kind = error instanceof DesktopError ? error.kind : "unknown";
    console.error(`desktop connection failed (${kind}); no model calls were made`);
    process.exit(1);
  }
  record("desktop", `connected, screen ${session.screen.width}x${session.screen.height}`);
  try {
    const observationId = randomUUID();
    const screenshot = await session.capture({ observationId, signal });
    record("capture", `observation ${observationId}, frame revision ${screenshot.frameRevision}`);
    // Evidence is saved before any model call, so a failed call still leaves the screen behind.
    const runDir = join(process.env.DIAGNOSTIC_DIR ?? "./diagnostics", `${new Date().toISOString().replace(/[:.]/g, "-")}-${observationId.slice(0, 8)}`);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "screen.png"), encodeRgbaPng(screenshot.width, screenshot.height, screenshot.rgba));

    const perceived = await perception.perceive({
      taskId: "diagnostic" as TaskId,
      screenshot,
      signal,
    });
    if (perceived.status === "abstained") {
      record("perception", `abstained: ${perceived.reason} (${scrub(perceived.detail)})`);
      await saveReport(runDir, { intent, timeline, observation: null, grounding: null, scrub });
      printTimeline(timeline);
      console.log(`spend: US$${totalSpend(timeline).toFixed(4)} (from provider usage; approximate if usage was not reported)`);
      console.log("result: abstained during perception");
      return;
    }
    record("perception", `${perceived.observation.elements.length} elements, ${perceived.rejectedElements} rejected`);

    const answer = await grounding.selectControl({ observation: perceived.observation, intent, signal });
    if (answer.status === "grounded") {
      record("grounding", `selected ${answer.value.id} "${answer.value.label}" (served by ${answer.servedBy}); no click sent`);
    } else {
      record("grounding", `abstained: ${answer.reason} (${scrub(answer.detail)})`);
    }
    await saveReport(runDir, { intent, timeline, observation: perceived.observation, grounding: answer, scrub });
    console.log(`evidence: ${runDir}`);
    printTimeline(timeline);
    console.log(`spend: US$${totalSpend(timeline).toFixed(4)} (from provider usage; approximate if usage was not reported)`);
  } finally {
    await session.close().catch(() => undefined);
    record("desktop", "disconnected");
  }
}

// Writes the readable trace next to the screenshot. Secrets are scrubbed from every string.
async function saveReport(
  dir: string,
  input: { intent: string; timeline: readonly TimelineEntry[]; observation: unknown; grounding: unknown; scrub: (text: string) => string },
): Promise<void> {
  const body = JSON.stringify(
    { intent: input.intent, timeline: input.timeline, observation: input.observation, grounding: input.grounding },
    null,
    2,
  );
  await writeFile(join(dir, "report.json"), input.scrub(body));
}

function totalSpend(entries: readonly TimelineEntry[]): number {
  return entries.reduce((total, entry) => total + (entry.costUsd ?? 0), 0);
}

function printTimeline(entries: readonly TimelineEntry[]): void {
  for (const entry of entries) {
    const cost = entry.costUsd === null ? "" : ` [US$${entry.costUsd.toFixed(4)}]`;
    console.log(`${entry.at}  ${entry.step.padEnd(11)} ${entry.detail}${cost}`);
  }
}

await main();
