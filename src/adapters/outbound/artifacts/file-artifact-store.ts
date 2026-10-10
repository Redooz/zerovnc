import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactRef, ArtifactStore } from "../../../application/ports/artifact-store.ts";
import type { Screenshot } from "../../../domain/desktop/screenshot.ts";
import type { TaskId } from "../../../domain/tasks/task.ts";
import { encodeRgbaPng } from "./png-encoder.ts";

// Stores screenshots as PNG files under <root>/<task id>/<sha256>.png. The file
// name is the content hash, so a stored artifact can be verified against its ref.
export class FileArtifactStore implements ArtifactStore {
  constructor(private readonly root: string) {}

  async storeScreenshot(input: { readonly taskId: TaskId; readonly screenshot: Screenshot }): Promise<ArtifactRef> {
    const { screenshot } = input;
    const png = encodeRgbaPng(screenshot.width, screenshot.height, screenshot.rgba);
    const sha256 = createHash("sha256").update(png).digest("hex");
    const relativeRef = join(input.taskId, `${sha256}.png`);
    const target = join(this.root, relativeRef);
    await mkdir(join(this.root, input.taskId), { recursive: true });
    // Write to a temp file and rename, so readers never see a partial image.
    const temp = `${target}.tmp`;
    await writeFile(temp, png);
    await rename(temp, target);
    return { ref: relativeRef, sha256, bytes: png.length };
  }
}
