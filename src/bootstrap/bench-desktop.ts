// Compares desktop encodings on the practice desktop: bun run bench:desktop [rounds]
// Read-only: it captures frames and never sends input. Reads EVAL_DESKTOP_URL and
// EVAL_DESKTOP_PASSWORD from the environment (Bun loads .env). Prints no secrets.
import { RfbConnection } from "../adapters/outbound/vnc/rfb-connection.ts";
import { RfbReader } from "../adapters/outbound/vnc/rfb-reader.ts";
import { openWebSocketTransport } from "../adapters/outbound/vnc/rfb-transport.ts";

const ENCODINGS = {
  raw: [0],
  hextile: [5, 1, 0],
} as const;
type Mode = keyof typeof ENCODINGS;

const url = process.env.EVAL_DESKTOP_URL;
const password = process.env.EVAL_DESKTOP_PASSWORD;
if (!url || !password) {
  console.error("set EVAL_DESKTOP_URL and EVAL_DESKTOP_PASSWORD (see .env.example)");
  process.exit(2);
}
const roundsArg = Number(process.argv[2] ?? 2);
const rounds = Number.isInteger(roundsArg) && roundsArg > 0 ? roundsArg : 2;
const FRAMES_PER_RUN = 3;

interface Run {
  readonly mode: Mode;
  readonly connectMs: number;
  readonly refreshMs: number[];
  readonly bytes: number[];
  readonly rgba: Uint8Array;
}

async function run(mode: Mode): Promise<Run> {
  const reader = new RfbReader();
  const signal = AbortSignal.timeout(30_000);
  const started = performance.now();
  const transport = await openWebSocketTransport(url!, reader, signal);
  const connection = await RfbConnection.establish({
    transport,
    reader,
    password: password!,
    signal,
    encodings: ENCODINGS[mode],
  });
  const connectMs = performance.now() - started;
  const refreshMs: number[] = [];
  const bytes: number[] = [];
  let rgba: Uint8Array = new Uint8Array(0);
  try {
    for (let i = 0; i < FRAMES_PER_RUN; i++) {
      const before = connection.bytesReceived;
      const t = performance.now();
      await connection.refresh(AbortSignal.timeout(30_000));
      refreshMs.push(performance.now() - t);
      bytes.push(connection.bytesReceived - before);
      rgba = connection.framebuffer.snapshot();
    }
  } finally {
    connection.close();
  }
  return { mode, connectMs, refreshMs, bytes, rgba };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

const runs: Run[] = [];
for (let round = 0; round < rounds; round++) {
  for (const mode of ["raw", "hextile"] as const) {
    const result = await run(mode);
    runs.push(result);
    console.log(
      `${mode.padEnd(8)} connect ${result.connectMs.toFixed(0)} ms  ` +
        `refresh median ${median(result.refreshMs).toFixed(0)} ms  bytes ${result.bytes.join(", ")}`,
    );
  }
}

const first = (mode: Mode) => runs.find((r) => r.mode === mode);
const raw = first("raw");
const hextile = first("hextile");
if (raw && hextile && raw.rgba.length === hextile.rgba.length) {
  let differing = 0;
  for (let i = 0; i < raw.rgba.length; i += 4) {
    if (raw.rgba[i] !== hextile.rgba[i] || raw.rgba[i + 1] !== hextile.rgba[i + 1] || raw.rgba[i + 2] !== hextile.rgba[i + 2]) {
      differing++;
    }
  }
  const pixels = raw.rgba.length / 4;
  console.log(`pixels differing raw vs hextile: ${differing} of ${pixels} (${((differing / pixels) * 100).toFixed(2)}%)`);
}
