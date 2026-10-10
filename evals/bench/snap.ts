// Dataset capture helper. Usage:
//   bun run evals/bench/snap.ts <name> [step ...]
// Steps run in order before the capture:
//   click:x,y   press and release the left button (held 150 ms)
//   type:text   clear the focused field (End, then Backspace), then type text
//   key:chord   press a key chord, e.g. key:Return or key:ctrl+a
//   wait:ms     pause
// Saves evals/bench/dataset/raw/<name>.{png,rgba,json}. This tool is for dataset
// capture only; the benchmark itself never sends input.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { VncDesktopSessionFactory } from "../../src/adapters/outbound/vnc/vnc-desktop-session.ts";
import { SystemClock } from "../../src/adapters/outbound/system/system-clock.ts";
import { encodeRgbaPng } from "../../src/adapters/outbound/artifacts/png-encoder.ts";
import { keysymsForChord, keysymsForText } from "../../src/application/desktop/keysyms.ts";

const [name, ...steps] = process.argv.slice(2);
if (!name) throw new Error("usage: snap.ts <name> [click:x,y | type:text | key:chord | wait:ms ...]");
const url = process.env.EVAL_DESKTOP_URL!;
const password = process.env.EVAL_DESKTOP_PASSWORD!;
const signal = AbortSignal.timeout(90_000);
const session = await new VncDesktopSessionFactory(new SystemClock()).connect({ url, password }, signal);

async function press(keysym: number): Promise<void> {
  await session.key({ down: true, keysym, signal });
  await Bun.sleep(20);
  await session.key({ down: false, keysym, signal });
  await Bun.sleep(20);
}

try {
  for (const step of steps) {
    const colon = step.indexOf(":");
    const verb = step.slice(0, colon);
    const arg = step.slice(colon + 1);
    if (verb === "click") {
      const [x, y] = arg.split(",").map(Number) as [number, number];
      await session.pointer({ buttons: 1, x, y, signal });
      await Bun.sleep(150);
      await session.pointer({ buttons: 0, x, y, signal });
      await Bun.sleep(1200);
    } else if (verb === "type") {
      // ctrl+a did not select field text on this desktop; clear with End + Backspace.
      for (const keysym of keysymsForChord("End") ?? []) await press(keysym);
      for (let i = 0; i < 40; i++) for (const keysym of keysymsForChord("BackSpace") ?? []) await press(keysym);
      for (const keysym of keysymsForText(arg)) await press(keysym);
      await Bun.sleep(300);
    } else if (verb === "key") {
      for (const keysym of keysymsForChord(arg) ?? []) await press(keysym);
      await Bun.sleep(1200);
    } else if (verb === "wait") {
      await Bun.sleep(Number(arg));
    } else {
      throw new Error(`unknown step ${step}`);
    }
  }
  const shot = await session.capture({ observationId: name, signal });
  const dir = join(import.meta.dir, "dataset", "raw");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.png`), encodeRgbaPng(shot.width, shot.height, shot.rgba));
  await writeFile(join(dir, `${name}.rgba`), shot.rgba);
  await writeFile(join(dir, `${name}.json`), JSON.stringify({ name, width: shot.width, height: shot.height, capturedAt: shot.capturedAt.toISOString() }, null, 2));
  console.log(`saved ${name} ${shot.width}x${shot.height}`);
} finally {
  await session.close().catch(() => undefined);
}
