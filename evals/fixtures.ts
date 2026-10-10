// Evaluator-owned fixture loader. Practice files contain expected results that
// must never reach the agent. Only `toAgentSubmission` output is sent to it.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const ExpectedChangeSchema = z.object({
  entidad: z.string(),
  id: z.string(),
  campo: z.string(),
  accion: z.string(),
  valor: z.unknown(),
});

export const PracticeFixtureSchema = z.object({
  id: z.string().min(1),
  nivel: z.string(),
  instruccion: z.string().min(1),
  estado_esperado: z.enum(["terminada", "fallida"]),
  respuesta_esperada: z
    .union([z.string(), z.number()])
    .transform((value) => String(value))
    .optional(),
  claves_razon: z.array(z.string()).default([]),
  diff_esperado: z.array(ExpectedChangeSchema),
  lista_blanca: z.array(z.unknown()).default([]),
});

export type PracticeFixture = z.infer<typeof PracticeFixtureSchema>;

export interface LoadedFixture {
  readonly fixture: PracticeFixture;
  // The exact JSON file content, used when calling the desktop checker.
  readonly raw: unknown;
  readonly file: string;
}

export async function loadPracticeFixtures(dir: string): Promise<LoadedFixture[]> {
  const files = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  if (files.length === 0) {
    throw new Error(`No practice fixtures found in ${dir}`);
  }
  const loaded: LoadedFixture[] = [];
  for (const file of files) {
    const raw: unknown = JSON.parse(await readFile(join(dir, file), "utf8"));
    const parsed = PracticeFixtureSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Invalid fixture ${file}: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
    }
    loaded.push({ fixture: parsed.data, raw, file });
  }
  return loaded;
}

export interface AgentSubmission {
  readonly tarea: string;
  readonly escritorio: { readonly url: string; readonly password: string };
}

// The only data the agent receives from a fixture: the literal instruction and
// the desktop access for this run.
export function toAgentSubmission(
  fixture: PracticeFixture,
  desktop: { readonly url: string; readonly password: string },
): AgentSubmission {
  return {
    tarea: fixture.instruccion,
    escritorio: { url: desktop.url, password: desktop.password },
  };
}
