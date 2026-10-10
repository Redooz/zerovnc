import { json } from "../http-responses.ts";

export function healthController(): Response {
  return json({ ok: true });
}
