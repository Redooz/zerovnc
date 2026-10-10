import type { CheckResult } from "./result.ts";

// Finds the `respuesta:` line. Only the first such line is graded.
const RESPUESTA_LINE = /^\s*respuesta\s*:\s*(.*)$/im;

export function gradeAnswer(expected: string | undefined, summary: string): CheckResult {
  const match = RESPUESTA_LINE.exec(summary);
  if (expected === undefined) {
    return match === null
      ? { name: "respuesta", outcome: "pass", detail: "no respuesta line, as required" }
      : { name: "respuesta", outcome: "fail", detail: "respuesta line present but the task has no answer" };
  }
  if (match === null) {
    return { name: "respuesta", outcome: "fail", detail: "missing respuesta line" };
  }
  const value = match[1] ?? "";
  const expectedParts = expected.split(";").map((part) => part.trim());
  const actualParts = value.split(";").map((part) => part.trim());

  if (expectedParts.length === 1) {
    // Single answer: a numeric expectation compares the first number on the line.
    const expectedValue = expectedParts[0] ?? "";
    const ok = isNumeric(expectedValue)
      ? firstNumber(value) === normalizeNumber(expectedValue)
      : normalizeText(value) === normalizeText(expectedValue);
    return {
      name: "respuesta",
      outcome: ok ? "pass" : "fail",
      detail: `expected ${expected}, got line value "${value.trim()}"`,
    };
  }

  // Two or more answers: same count, same order, separated by ';'.
  if (actualParts.length !== expectedParts.length) {
    return {
      name: "respuesta",
      outcome: "fail",
      detail: `expected ${expectedParts.length} values, got ${actualParts.length}`,
    };
  }
  const mismatches = expectedParts.flatMap((expectedPart, index) => {
    const actualPart = actualParts[index] ?? "";
    const ok = isNumeric(expectedPart)
      ? firstNumber(actualPart) === normalizeNumber(expectedPart)
      : normalizeText(actualPart) === normalizeText(expectedPart);
    return ok ? [] : [`value ${index + 1}`];
  });
  return {
    name: "respuesta",
    outcome: mismatches.length === 0 ? "pass" : "fail",
    detail: mismatches.length === 0 ? "all values match in order" : `mismatch: ${mismatches.join(", ")}`,
  };
}

export function isNumeric(value: string): boolean {
  return /^-?\d+(?:[.,]\d+)*$/.test(value.trim());
}

// Canonical form of a number token. Groups of exactly three digits after a
// separator are thousands ("1.245" -> 1245). Otherwise the separator is a
// decimal point ("4,5" -> 4.5). Anything else is kept as written, so it fails
// rather than matching by accident.
export function normalizeNumber(value: string): string {
  const trimmed = value.trim();
  const negative = trimmed.startsWith("-");
  const body = negative ? trimmed.slice(1) : trimmed;
  let canonical: string;
  if (/^\d{1,3}(?:[.,]\d{3})+$/.test(body)) {
    canonical = body.replace(/[.,]/g, "");
  } else if (/^\d+[.,]\d+$/.test(body)) {
    const [intPart = "", fracPart = ""] = body.split(/[.,]/);
    canonical = `${intPart.replace(/^0+(?=\d)/, "")}.${fracPart}`;
  } else {
    canonical = body.replace(/^0+(?=\d)/, "");
  }
  return (negative ? "-" : "") + canonical;
}

// First number on the text, using the same canonical form.
export function firstNumber(text: string): string | null {
  const match = /-?\d+(?:[.,]\d+)*/.exec(text);
  return match === null ? null : normalizeNumber(match[0]);
}

export function normalizeText(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}
