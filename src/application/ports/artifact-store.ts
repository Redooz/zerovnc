import type { Screenshot } from "../../domain/desktop/screenshot.ts";
import type { TaskId } from "../../domain/tasks/task.ts";

// Stores large evidence outside the database. Refs are stable, relative to the
// artifact root, and never contain credentials.
export interface ArtifactRef {
  readonly ref: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface ArtifactStore {
  storeScreenshot(input: { readonly taskId: TaskId; readonly screenshot: Screenshot }): Promise<ArtifactRef>;
}
