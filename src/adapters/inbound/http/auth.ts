import { timingSafeEqual } from "node:crypto";

// Checks `Authorization: Bearer <token>` in constant time.
export function isAuthorized(request: Request, expectedToken: string): boolean {
  const header = request.headers.get("authorization");
  if (header === null) return false;
  const match = /^Bearer (.+)$/.exec(header);
  if (match === null || match[1] === undefined) return false;
  const given = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}
