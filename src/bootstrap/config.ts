import { z } from "zod";

// Runtime configuration, validated once at startup. Secrets are read from the
// environment only and are never echoed back in error messages.

const DEFAULT_TASK_TIMEOUT_MS = 300_000;

// Model IDs are configuration, never hardcoded in adapters. Defaults are the
// Phase 3 choices; changing a model must not require a code change.
export const DEFAULT_MODELS = {
  perception: "anthropic/claude-haiku-5.5",
  perceptionFallback: "deepseek/deepseek-v4.1-flash",
  decision: "jev-latest",
  decisionFallback: "openai/gpt-6-luna-decisions",
} as const;

// Provider/model style identifiers. Rejects whitespace, quotes, and control characters.
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._:-]*)*$/;
const ModelIdSchema = z.string().trim().min(1).max(200).regex(MODEL_ID_PATTERN, "must be a model identifier such as provider/model");

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  AGENT_BEARER_TOKEN: z.string().min(16, "AGENT_BEARER_TOKEN must be at least 16 characters"),
  OPENROUTER_API_KEY: z.string().min(1, "OPENROUTER_API_KEY is required"),
  DATABASE_PATH: z.string().min(1).default("./data/agent.sqlite"),
  ARTIFACT_DIR: z.string().min(1).default("./artifacts"),
  PERCEPTION_MODEL: ModelIdSchema.default(DEFAULT_MODELS.perception),
  PERCEPTION_FALLBACK_MODEL: ModelIdSchema.default(DEFAULT_MODELS.perceptionFallback),
  DECISION_MODEL: ModelIdSchema.default(DEFAULT_MODELS.decision),
  DECISION_FALLBACK_MODEL: ModelIdSchema.default(DEFAULT_MODELS.decisionFallback),
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
  readonly models: ModelConfig;
}

export interface ModelConfig {
  readonly perception: string;
  readonly perceptionFallback: string;
  readonly decision: string;
  readonly decisionFallback: string;
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
    models: {
      perception: values.PERCEPTION_MODEL,
      perceptionFallback: values.PERCEPTION_FALLBACK_MODEL,
      decision: values.DECISION_MODEL,
      decisionFallback: values.DECISION_FALLBACK_MODEL,
    },
  };
}
