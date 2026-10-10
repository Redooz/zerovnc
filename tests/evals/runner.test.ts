import { describe, expect, test } from "bun:test";
import { runEvaluation, redact } from "../../evals/runner.ts";
import { PracticeFixtureSchema, type LoadedFixture, type AgentSubmission } from "../../evals/fixtures.ts";
import type { AgentClient, DesktopControl } from "../../evals/ports.ts";
import type { AgentOutcome } from "../../evals/graders/index.ts";
import type { AppStateEvidence } from "../../evals/graders/app-state.ts";
import { HttpAgentClient } from "../../evals/adapters/http-agent-client.ts";

const PASSWORD = "pw-escritorio-424242";

function loaded(id: string, estado: "terminada" | "fallida", extra: Record<string, unknown> = {}): LoadedFixture {
  const raw = { id, nivel: "facil", instruccion: `tarea ${id}`, estado_esperado: estado, diff_esperado: [], ...extra };
  return { fixture: PracticeFixtureSchema.parse(raw), raw, file: `${id}.json` };
}

// Fake clock: each sleep advances time, so no real waiting happens.
function fakeTime() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

class ScriptedAgent implements AgentClient {
  submissions: AgentSubmission[] = [];
  polls = 0;
  constructor(private readonly script: (pollIndex: number) => AgentOutcome, private readonly failSubmit = false) {}
  async submit(submission: AgentSubmission): Promise<string> {
    if (this.failSubmit) throw new Error("connection refused");
    this.submissions.push(submission);
    return `task-${this.submissions.length}`;
  }
  async poll(): Promise<AgentOutcome> {
    return this.script(this.polls++);
  }
}

class FakeDesktop implements DesktopControl {
  resets = 0;
  constructor(private readonly evidence: AppStateEvidence, private readonly failReset = false) {}
  async reset(): Promise<void> {
    if (this.failReset) throw new Error("reset refused");
    this.resets += 1;
  }
  async check(): Promise<AppStateEvidence> {
    return this.evidence;
  }
}

const OK_EVIDENCE: AppStateEvidence = { kind: "checked", pass: true, checks: [{ nombre: "cambios esperados", ok: true }] };
const ACCESS = { url: "wss://d.example/websockify", password: PASSWORD };

describe("runEvaluation", () => {
  test("polls until terminal, grades, and reports pass", async () => {
    const time = fakeTime();
    const agent = new ScriptedAgent((i) => (i < 2 ? { estado: "en_curso", resumen: "" } : { estado: "terminada", resumen: "respuesta: 45" }));
    const desktop = new FakeDesktop(OK_EVIDENCE);
    const report = await runEvaluation({
      fixtures: [loaded("E3", "terminada", { respuesta_esperada: "45" })],
      agent,
      desktop,
      access: ACCESS,
      secrets: [PASSWORD],
      pollIntervalMs: 5_000,
      deadlineMs: 300_000,
      sleep: time.sleep,
      now: time.now,
    });
    expect(agent.polls).toBe(3);
    expect(desktop.resets).toBe(1);
    expect(report.counts).toEqual({ pass: 1, fail: 0, not_evaluated: 0 });
    expect(report.runs[0]?.elapsedMs).toBe(10_000);
    expect(agent.submissions[0]).toEqual({ tarea: "tarea E3", escritorio: ACCESS });
  });

  test("a task still running at the 5-minute limit is graded as failed and timed out", async () => {
    const time = fakeTime();
    const agent = new ScriptedAgent(() => ({ estado: "en_curso", resumen: "" }));
    const report = await runEvaluation({
      fixtures: [loaded("E1", "terminada")],
      agent,
      desktop: new FakeDesktop(OK_EVIDENCE),
      access: ACCESS,
      secrets: [PASSWORD],
      pollIntervalMs: 5_000,
      deadlineMs: 300_000,
      sleep: time.sleep,
      now: time.now,
    });
    const run = report.runs[0];
    expect(run?.timedOut).toBe(true);
    expect(run?.verdict).toBe("fail");
    expect(run?.elapsedMs).toBeGreaterThanOrEqual(300_000);
  });

  test("without a desktop checker, the verdict is not_evaluated, not pass", async () => {
    const time = fakeTime();
    const agent = new ScriptedAgent(() => ({ estado: "terminada", resumen: "Registrado." }));
    const report = await runEvaluation({
      fixtures: [loaded("E1", "terminada")],
      agent,
      desktop: null,
      access: ACCESS,
      secrets: [PASSWORD],
      sleep: time.sleep,
      now: time.now,
    });
    expect(report.runs[0]?.verdict).toBe("not_evaluated");
    expect(report.counts.pass).toBe(0);
  });

  test("a result that arrives after the limit does not count as success", async () => {
    const time = fakeTime();
    // The agent reports terminada, but only after 301 s.
    const agent = new ScriptedAgent(() => {
      return time.now() >= 301_000 ? { estado: "terminada", resumen: "Hecho." } : { estado: "en_curso", resumen: "" };
    });
    const report = await runEvaluation({
      fixtures: [loaded("E1", "terminada")],
      agent,
      desktop: new FakeDesktop(OK_EVIDENCE),
      access: ACCESS,
      secrets: [PASSWORD],
      pollIntervalMs: 5_000,
      deadlineMs: 300_000,
      sleep: time.sleep,
      now: time.now,
    });
    const run = report.runs[0];
    expect(run?.timedOut).toBe(true);
    expect(run?.verdict).toBe("fail");
  });

  test("the five-minute limit starts after the desktop reset", async () => {
    const time = fakeTime();
    // Reset takes 250 s and is not part of the task budget. The task then
    // finishes about 55 s after submission: 305 s total, which only passes if
    // the reset time is excluded.
    const desktop: DesktopControl = {
      reset: async () => {
        await time.sleep(250_000);
      },
      check: async () => OK_EVIDENCE,
    };
    const agent = new ScriptedAgent((i) => (i < 11 ? { estado: "en_curso", resumen: "" } : { estado: "terminada", resumen: "Hecho." }));
    const report = await runEvaluation({
      fixtures: [loaded("E1", "terminada")],
      agent,
      desktop,
      access: ACCESS,
      secrets: [PASSWORD],
      pollIntervalMs: 5_000,
      deadlineMs: 300_000,
      sleep: time.sleep,
      now: time.now,
    });
    expect(report.runs[0]?.timedOut).toBe(false);
    expect(report.runs[0]?.verdict).toBe("pass");
  });

  test("a failed reset means the task is not sent and is not_evaluated", async () => {
    const time = fakeTime();
    const agent = new ScriptedAgent(() => ({ estado: "terminada", resumen: "" }));
    const report = await runEvaluation({
      fixtures: [loaded("E1", "terminada")],
      agent,
      desktop: new FakeDesktop(OK_EVIDENCE, true),
      access: ACCESS,
      secrets: [PASSWORD],
      sleep: time.sleep,
      now: time.now,
    });
    expect(agent.submissions.length).toBe(0);
    expect(report.runs[0]?.verdict).toBe("not_evaluated");
  });

  test("a rejected submission is graded as a failure", async () => {
    const time = fakeTime();
    const report = await runEvaluation({
      fixtures: [loaded("E1", "terminada")],
      agent: new ScriptedAgent(() => ({ estado: "terminada", resumen: "" }), true),
      desktop: new FakeDesktop(OK_EVIDENCE),
      access: ACCESS,
      secrets: [PASSWORD],
      sleep: time.sleep,
      now: time.now,
    });
    expect(report.runs[0]?.verdict).toBe("fail");
    expect(report.runs[0]?.taskId).toBeNull();
  });

  test("secrets never appear in the report, including check details", async () => {
    const time = fakeTime();
    const leaky = `respuesta: ${PASSWORD}`;
    const report = await runEvaluation({
      fixtures: [loaded("E3", "terminada", { respuesta_esperada: "45" })],
      agent: new ScriptedAgent(() => ({ estado: "terminada", resumen: leaky })),
      desktop: new FakeDesktop(OK_EVIDENCE),
      access: ACCESS,
      secrets: [PASSWORD],
      sleep: time.sleep,
      now: time.now,
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(PASSWORD);
    expect(report.runs[0]?.verdict).toBe("fail");
  });

  test("redact replaces every occurrence of each secret", () => {
    expect(redact("a-b-a", ["a"])).toBe("[REDACTED]-b-[REDACTED]");
    expect(redact("nada", [""])).toBe("nada");
  });
});

describe("HTTP agent client timeouts", () => {
  test("a stalled agent request is aborted instead of hanging", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
    try {
      const client = new HttpAgentClient(`http://localhost:${server.port}`, "token-for-test-only-123", 50);
      const started = Date.now();
      await expect(client.poll("t1")).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      server.stop(true);
    }
  });

  test("a request near the deadline is capped by the remaining budget, not the fixed timeout", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (req) => (req.method === "POST" ? Response.json({ task_id: "t1" }) : new Promise<Response>(() => {})),
    });
    try {
      // Fixed request timeout is 10 s; the task limit is 300 ms. The run must end near 300 ms.
      const client = new HttpAgentClient(`http://localhost:${server.port}`, "token-for-test-only-123", 10_000);
      const started = Date.now();
      const report = await runEvaluation({
        fixtures: [loaded("E1", "terminada")],
        agent: client,
        desktop: null,
        access: ACCESS,
        secrets: [PASSWORD],
        pollIntervalMs: 50,
        deadlineMs: 300,
      });
      const elapsed = Date.now() - started;
      expect(report.runs[0]?.timedOut).toBe(true);
      expect(report.runs[0]?.verdict).toBe("fail");
      expect(elapsed).toBeLessThan(2_000);
    } finally {
      server.stop(true);
    }
  });

  test("a terminal answer that arrives after the deadline is never accepted", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        if (req.method === "POST") return Response.json({ task_id: "t1" });
        // Answers "terminada" only after the 300 ms limit has passed.
        await Bun.sleep(600);
        return Response.json({ estado: "terminada", resumen: "respuesta: 45" });
      },
    });
    try {
      const client = new HttpAgentClient(`http://localhost:${server.port}`, "token-for-test-only-123", 10_000);
      const report = await runEvaluation({
        fixtures: [loaded("E3", "terminada", { respuesta_esperada: "45" })],
        agent: client,
        desktop: new FakeDesktop(OK_EVIDENCE),
        access: ACCESS,
        secrets: [PASSWORD],
        pollIntervalMs: 50,
        deadlineMs: 300,
      });
      const run = report.runs[0];
      expect(run?.timedOut).toBe(true);
      expect(run?.actualStatus).not.toBe("terminada");
      expect(run?.verdict).toBe("fail");
    } finally {
      server.stop(true);
    }
  });

  test("the last poll sleep is capped at the remaining task budget", async () => {

    const time = fakeTime();
    const sleeps: number[] = [];
    const agent = new ScriptedAgent(() => ({ estado: "en_curso", resumen: "" }));
    const report = await runEvaluation({
      fixtures: [loaded("E1", "terminada")],
      agent,
      desktop: new FakeDesktop(OK_EVIDENCE),
      access: ACCESS,
      secrets: [PASSWORD],
      pollIntervalMs: 5_000,
      deadlineMs: 12_000,
      sleep: async (ms) => {
        sleeps.push(ms);
        await time.sleep(ms);
      },
      now: time.now,
    });
    expect(sleeps).toEqual([5_000, 5_000, 2_000]);
    expect(report.runs[0]?.elapsedMs).toBe(12_000);
  });
});
