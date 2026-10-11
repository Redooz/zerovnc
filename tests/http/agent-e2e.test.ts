// End-to-end through the HTTP API (the evaluator's path): submit a task, the Pi planner calls the
// desktop tools, verification passes, and the task ends terminada. Model and desktop are doubles.
import { afterEach, describe, expect, test } from "bun:test";
import { createApp, type App } from "../../src/bootstrap/server.ts";
import type { AppConfig } from "../../src/bootstrap/config.ts";
import { PiAgentPlanner } from "../../src/adapters/outbound/pi/pi-agent-planner.ts";
import type { ToolChatCall, ToolChatReply } from "../../src/adapters/outbound/openrouter/openrouter-client.ts";
import { createScreenshot } from "../../src/domain/desktop/screenshot.ts";
import { stubModels, decisionRoute } from "../support/agent-doubles.ts";
import { ModelCallError } from "../../src/application/ports/model-call-error.ts";
import type { ModelRoutes } from "../../src/bootstrap/models.ts";

const TOKEN = "test-token-0123456789abcdef";
const BASE = "http://agent.test";
const clock = { now: () => new Date("2026-10-10T12:00:00.000Z") };
const silent = { info() {}, error() {} };

function config(): AppConfig {
  return {
    port: 0,
    bearerToken: TOKEN,
    openRouterApiKey: "k",
    databasePath: ":memory:",
    artifactDir: "./artifacts-test",
    taskTimeoutMs: 300_000,
    models: {
      perception: "anthropic/claude-haiku-5.5",
      perceptionFallback: "deepseek/deepseek-v4.1-flash",
      decision: "jev-latest",
      decisionFallback: "openai/gpt-6-luna-decisions",
      planner: "anthropic/claude-haiku-5.5",
      plannerFallback: "deepseek/deepseek-v4.1-flash",
    },
  };
}

function toolReply(calls: Array<{ name: string; args: unknown }>): ToolChatReply {
  return {
    content: null,
    toolCalls: calls.map((c, i) => ({ id: `call_${i}_${c.name}`, name: c.name, arguments: JSON.stringify(c.args) })),
    finishReason: "tool_calls",
    servedBy: "anthropic/claude-haiku-5.5",
    promptTokens: 100,
    completionTokens: 10,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: 0,
    latencyMs: 1,
  };
}

function textReply(content: string): ToolChatReply {
  return { ...toolReply([]), content, finishReason: "stop" };
}

function desktop() {
  return {
    async connect() {
      return {
        screen: { width: 4, height: 4 },
        async capture(input: { observationId: string }) {
          return createScreenshot({ observationId: input.observationId, capturedAt: new Date(clock.now()), width: 4, height: 4, frameRevision: 1, rgba: new Uint8Array(64) });
        },
        async pointer() {},
        async key() {},
        async close() {},
      };
    },
  };
}

let app: App | null = null;
afterEach(async () => {
  await app?.shutdown();
  app = null;
});

describe("agent loop through the HTTP API", () => {
  test("a task completes through the Pi planner only after verification passes", async () => {
    const requests: ToolChatCall[] = [];
    const replies: ToolChatReply[] = [
      toolReply([
        { name: "set_plan", args: { goal: "Registrar cliente", completion_conditions: ["Guardar is visible"] } },
        { name: "verify_result", args: {} },
      ]),
      textReply("Cliente registrado. Ninguna respuesta solicitada."),
    ];
    const client = {
      async completeWithTools(call: ToolChatCall) {
        requests.push(call);
        const next = replies.shift();
        if (next === undefined) throw new ModelCallError("provider", "no scripted reply");
        return next;
      },
    };
    const decision = decisionRoute({ level: "supported" });
    const models = stubModels();
    app = createApp(config(), {
      logger: silent,
      clock,
      models: { ...models, decision: { primary: decision, fallback: decision }, client: client as unknown as ModelRoutes["client"] },
      planner: new PiAgentPlanner({
        client,
        primaryModel: "anthropic/claude-haiku-5.5",
        fallbackModel: null,
        prompt: { version: "planner.test.v1", text: "Eres un agente de escritorio." },
        cacheBreakpoint: () => false,
      }),
      desktopSessions: desktop(),
      artifacts: { async storeScreenshot() { return { ref: "t.png", sha256: "0", bytes: 0 }; } },
    });

    const submitted = await app.fetch(
      new Request(`${BASE}/tasks`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ tarea: "Registra a Ana Torres.", escritorio: { url: "wss://desk.example/websockify", password: "pw-secreto-123" } }),
      }),
    );
    expect(submitted.status).toBe(202);
    const { task_id } = (await submitted.json()) as { task_id: string };

    let final = { estado: "en_curso", resumen: "" };
    for (let i = 0; i < 400 && final.estado === "en_curso"; i++) {
      final = (await (await app.fetch(new Request(`${BASE}/tasks/${task_id}`, { headers: { authorization: `Bearer ${TOKEN}` } }))).json()) as typeof final;
      await Bun.sleep(5);
    }
    expect(final.estado).toBe("terminada");
    expect(final.resumen).toBe("Cliente registrado. Ninguna respuesta solicitada.");
    // The planner was offered the desktop tools with their schemas.
    expect(requests[0]!.tools.map((t) => t.function.name)).toEqual(expect.arrayContaining(["observe_screen", "click_control", "verify_result"]));
  });
});
