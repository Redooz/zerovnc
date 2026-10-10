// Models sometimes wrap JSON in a Markdown fence. Only that wrapper is removed.
export function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}
