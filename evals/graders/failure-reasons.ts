import type { CheckResult } from "./result.ts";

// Each expected reason key must appear in the summary. Punctuation and spacing
// are ignored, so "52.345.678" matches "52345678".
export function gradeFailureReasons(keys: readonly string[], summary: string): CheckResult {
  if (keys.length === 0) {
    return { name: "razon", outcome: "pass", detail: "no failure reasons required" };
  }
  const haystack = squash(summary);
  const missing = keys.filter((key) => !haystack.includes(squash(key)));
  return {
    name: "razon",
    outcome: missing.length === 0 ? "pass" : "fail",
    detail: missing.length === 0 ? "all reason keys named" : `missing: ${missing.join(", ")}`,
  };
}

function squash(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
}
