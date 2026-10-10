import type { IdGenerator } from "../../../application/ports/id-generator.ts";

export class RandomIdGenerator implements IdGenerator {
  next(): string {
    return crypto.randomUUID();
  }
}
