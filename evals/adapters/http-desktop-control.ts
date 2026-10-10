import { z } from "zod";
import type { AppStateEvidence } from "../graders/app-state.ts";
import type { DesktopControl } from "../ports.ts";

const CheckResponseSchema = z.object({
  pass: z.boolean(),
  checks: z.array(z.object({ nombre: z.string(), ok: z.boolean() })),
});

// Calls the desktop's reset and check endpoints. Check results carry no app
// values, only pass/fail per named check.
export class HttpDesktopControl implements DesktopControl {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    // Reset restarts the browser, so it gets more time than a check.
    private readonly resetTimeoutMs: number = 60_000,
    private readonly checkTimeoutMs: number = 15_000,
  ) {}

  async reset(): Promise<void> {
    const response = await fetch(new URL("/__reset", this.baseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(this.resetTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(`POST /__reset failed with status ${response.status}`);
    }
  }

  async check(practice: unknown): Promise<AppStateEvidence> {
    try {
      const response = await fetch(new URL("/__check", this.baseUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify(practice),
        signal: AbortSignal.timeout(this.checkTimeoutMs),
      });
      if (!response.ok) {
        return { kind: "unavailable", reason: `POST /__check failed with status ${response.status}` };
      }
      const parsed = CheckResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        return { kind: "unavailable", reason: "POST /__check returned an unexpected body" };
      }
      return { kind: "checked", pass: parsed.data.pass, checks: parsed.data.checks };
    } catch {
      return { kind: "unavailable", reason: "desktop checker unreachable" };
    }
  }
}
