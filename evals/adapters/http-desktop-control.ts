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
  ) {}

  async reset(): Promise<void> {
    const response = await fetch(new URL("/__reset", this.baseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}` },
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
