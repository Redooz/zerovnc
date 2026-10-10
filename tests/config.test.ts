import { describe, expect, test } from "bun:test";
import { ConfigError, loadConfig } from "../src/bootstrap/config.ts";

const TOKEN = "a-long-enough-bearer-token";

describe("loadConfig", () => {
  test("applies defaults and reads the task timeout", () => {
    const config = loadConfig({ AGENT_BEARER_TOKEN: TOKEN, OPENROUTER_API_KEY: "k" });
    expect(config.port).toBe(8080);
    expect(config.taskTimeoutMs).toBe(300_000);
    expect(config.databasePath).toBe("./data/agent.sqlite");
  });

  test("reports field names without echoing values", () => {
    const secretish = "tooshort-1";
    try {
      loadConfig({ AGENT_BEARER_TOKEN: secretish, OPENROUTER_API_KEY: "" });
      throw new Error("expected ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as Error).message;
      expect(message).toContain("AGENT_BEARER_TOKEN");
      expect(message).toContain("OPENROUTER_API_KEY");
      expect(message).not.toContain(secretish);
    }
  });

  test("rejects a missing OpenRouter key and out-of-range port", () => {
    expect(() => loadConfig({ AGENT_BEARER_TOKEN: TOKEN })).toThrow(ConfigError);
    expect(() => loadConfig({ AGENT_BEARER_TOKEN: TOKEN, OPENROUTER_API_KEY: "k", PORT: "70000" })).toThrow(ConfigError);
  });

  test("model IDs default to the Phase 3 choices and can be overridden without code changes", () => {
    const defaults = loadConfig({ AGENT_BEARER_TOKEN: TOKEN, OPENROUTER_API_KEY: "k" }).models;
    expect(defaults).toEqual({
      perception: "anthropic/claude-haiku-5.5",
      perceptionFallback: "deepseek/deepseek-v4.1-flash",
      decision: "jev-latest",
      decisionFallback: "openai/gpt-6-luna-decisions",
    });
    const overridden = loadConfig({
      AGENT_BEARER_TOKEN: TOKEN,
      OPENROUTER_API_KEY: "k",
      PERCEPTION_MODEL: "google/gemini-x",
      DECISION_FALLBACK_MODEL: "openai/other-model",
    }).models;
    expect(overridden.perception).toBe("google/gemini-x");
    expect(overridden.decisionFallback).toBe("openai/other-model");
  });

  test("malformed model IDs are rejected at startup", () => {
    expect(() => loadConfig({ AGENT_BEARER_TOKEN: TOKEN, OPENROUTER_API_KEY: "k", DECISION_MODEL: "bad model; drop" })).toThrow(/DECISION_MODEL/);
    expect(() => loadConfig({ AGENT_BEARER_TOKEN: TOKEN, OPENROUTER_API_KEY: "k", PERCEPTION_MODEL: "" })).toThrow(ConfigError);
  });
});
