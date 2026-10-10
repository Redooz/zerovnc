import { readFileSync } from "node:fs";

// Prompts are versioned files. The first line must declare the version, and the
// version is recorded in every trace event that used the prompt.
export interface PromptFile {
  readonly version: string;
  readonly text: string;
}

const VERSION_LINE = /^<!-- prompt-version: ([A-Za-z0-9._-]+) -->\n/;

export function parsePromptFile(source: string): PromptFile {
  const match = VERSION_LINE.exec(source);
  if (match === null || match[1] === undefined) {
    throw new Error("prompt file must start with a <!-- prompt-version: ... --> line");
  }
  return { version: match[1], text: source.slice(match[0].length).trim() };
}

export function loadPromptFile(name: string): PromptFile {
  const url = new URL(`./prompts/${name}`, import.meta.url);
  return parsePromptFile(readFileSync(url, "utf8"));
}
