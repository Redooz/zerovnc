// The calibration chosen on development, frozen so the held-out run uses exactly it.
// Held-out refuses to run if the models, prompts, question template, or labels changed
// since the freeze: otherwise held-out results would not confirm what was tuned.
export interface FrozenConfig {
  readonly version: "frozen.v1";
  readonly frozenAt: string;
  readonly datasetHash: string;
  readonly models: Readonly<Record<string, string>>;
  readonly prompts: Readonly<Record<string, string>>;
  // Per decision configuration.
  readonly calibration: Readonly<Record<string, { readonly threshold: number; readonly minMargin: number }>>;
}

export interface CurrentSetup {
  readonly datasetHash: string;
  readonly models: Readonly<Record<string, string>>;
  readonly prompts: Readonly<Record<string, string>>;
}

export function createFrozen(setup: CurrentSetup, calibration: FrozenConfig["calibration"], at: string): FrozenConfig {
  return { version: "frozen.v1", frozenAt: at, datasetHash: setup.datasetHash, models: setup.models, prompts: setup.prompts, calibration };
}

// Every difference between the frozen setup and the current one. Empty means held-out may run.
export function frozenMismatches(frozen: FrozenConfig, current: CurrentSetup): string[] {
  const problems: string[] = [];
  if (frozen.datasetHash !== current.datasetHash) problems.push("labelled cases changed since the freeze");
  for (const [key, value] of Object.entries(frozen.models)) {
    if (current.models[key] !== value) problems.push(`model ${key} changed: ${value} -> ${current.models[key] ?? "unset"}`);
  }
  for (const [key, value] of Object.entries(frozen.prompts)) {
    if (current.prompts[key] !== value) problems.push(`prompt ${key} changed: ${value} -> ${current.prompts[key] ?? "unset"}`);
  }
  return problems;
}
