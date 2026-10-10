export const REDACTED = "[redacted]";

// Replaces every occurrence of each secret with a marker, in strings nested at any
// depth. Empty secrets are ignored. Values are copied; the input is not modified.
export function redactValue<T>(value: T, secrets: readonly string[]): T {
  // Longest first, so a secret that contains another is replaced whole.
  const known = secrets.filter((secret) => secret.length > 0).sort((a, b) => b.length - a.length);
  if (known.length === 0) return value;
  return redactNode(value, known) as T;
}

function redactNode(node: unknown, secrets: readonly string[]): unknown {
  if (typeof node === "string") {
    let out = node;
    for (const secret of secrets) out = out.split(secret).join(REDACTED);
    return out;
  }
  if (Array.isArray(node)) return node.map((item) => redactNode(item, secrets));
  if (node instanceof Date || node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(node)) {
    out[key] = redactNode(child, secrets);
  }
  return out;
}
