import { z } from "zod";

// Runtime configuration, validated once at startup. Secrets are read from the
// environment only and are never echoed back in error messages.

const DEFAULT_TASK_TIMEOUT_MS = 300_000;

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  AGENT_BEARER_TOKEN: z.string().min(16, "AGENT_BEARER_TOKEN must be at least 16 characters"),
  OPENROUTER_API_KEY: z.string().min(1, "OPENROUTER_API_KEY is required"),
  DATABASE_PATH: z.string().min(1).default("./data/agent.sqlite"),
  ARTIFACT_DIR: z.string().min(1).default("./artifacts"),
  TASK_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(DEFAULT_TASK_TIMEOUT_MS * 12)
    .default(DEFAULT_TASK_TIMEOUT_MS),
});

export interface AppConfig {
  readonly port: number;
  readonly bearerToken: string;
  readonly openRouterApiKey: string;
  readonly databasePath: string;
  readonly artifactDir: string;
  readonly taskTimeoutMs: number;
}

export class ConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid configuration: ${issues.join("; ")}`);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    // Report field names and messages only; never values.
    const issues = parsed.error.issues.map((issue) => {
      const field = issue.path.join(".") || "(root)";
      return `${field}: ${issue.message}`;
    });
    throw new ConfigError(issues);
  }
  const values = parsed.data;
  return {
    port: values.PORT,
    bearerToken: values.AGENT_BEARER_TOKEN,
    openRouterApiKey: values.OPENROUTER_API_KEY,
    databasePath: values.DATABASE_PATH,
    artifactDir: values.ARTIFACT_DIR,
    taskTimeoutMs: values.TASK_TIMEOUT_MS,
  };
}
