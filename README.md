# zerovnc

An agent that operates API-less business apps the way a new employee would: it looks at the screen over VNC/RFB, figures out where things are, does the task, and checks the result. No per-app setup, no recorded macros, no API access — only what is visible on screen.

## What it can do

- Takes a task in natural language: create or update records, answer filtered counting questions, run exports.
- Reads any screen like it is new: a perception model turns a capture into controls, labels, values, bounding boxes, and disabled-state flags; a separate decision model answers narrow grounding questions ("which button saves this?") with a confidence level, and abstains when unsure.
- Acts only through guarded application tools (`observe_screen`, `click_control`, `select_record`, `replace_field`, `scroll_screen`, `press_key`, `verify_result`). Code, not the model, enforces frame freshness, unambiguous targets, disabled controls, the task deadline, and input serialization.
- Reports success only from verified on-screen evidence; refuses ambiguous or impossible tasks with reasons; makes only the requested changes; never leaks secrets in its summaries.
- Handles the real-world quirks: clicks held at least 100 ms, captures taken after the repaint window, select-all before replacing text, and dates from the app's displayed clock.

## Demos

Real runs, one screenshot per agent step:

<p align="center"><video src="docs/demos/demo-count-overdue.mp4" controls muted loop width="640"></video></p>
<p align="center"><sub>Counts a client's overdue invoices by filtering by client and status, then paging the whole result (SIGECOM, the training app). Done in 2 min 19 s.</sub></p>

<p align="center"><video src="docs/demos/demo-update-patient.mp4" controls muted loop width="640"></video></p>
<p align="center"><sub>Updates one field of a patient record and verifies the saved value (Clínica Los Cerezos — an app the agent had never seen). Done in 1 min 46 s.</sub></p>

<p align="center"><video src="docs/demos/demo-cancel-appointment.mp4" controls muted loop width="640"></video></p>
<p align="center"><sub>Cancels an appointment through a confirmation dialog and picks the reason (Clínica Los Cerezos). Done in 2 min 14 s.</sub></p>

## How it is built

- Bun + TypeScript in strict hexagonal layers: `src/domain` (invariants) → `src/application` (agent loop, tools, grounding, perception, ports) → `src/adapters` (HTTP, SQLite, RFB/VNC, OpenRouter, Pi) → `src/bootstrap` (composition root and HTTP server). Domain and application code import no adapter types.
- A custom RFB/VNC client (Raw + CopyRect by default) with bounded shutdown and deadline-capped release.
- One loop, one source of truth: models propose targets, tools dispose, and only the loop sets `terminada` or `fallida` — always from current verification evidence, never from the planner's claim of success.
- Models are called through OpenRouter only (perception + the Decisions API). Prompts are versioned files, model IDs are configuration, and thresholds are per model. Counting and date arithmetic happen in code, not in the model.
- Every run is traced: SQLite events plus screenshots and transcripts, with a timeline CLI and secret redaction in storage and summaries.
- Verified learning: after a task finishes, the agent saves the UI targets it used, keyed to the app and starting screen. It rechecks them against the screen before reuse, keeps out record data and secrets, and discards stale notes.

## Measured results

- Decision benchmark: 95–100% accuracy across labelled grounding cases, 0 wrong groundings; disabled-control recall 3/3 with 0 false flags.
- Perception v5 halved screen-reading latency (p50 10.3 s → 6.7 s), so the full observe → plan → act → verify cycle fits inside the 5-minute task budget.
- ~400 offline tests; deterministic, no paid calls.

## Repo layout

```
src/            domain / application / adapters / bootstrap as above
design/         architecture doc + Mermaid diagram
docs/demos/     recordings of real task runs
evals/          end-to-end runner, graders (app state, answers, failure reasons, secrets)
                and component benchmarks with labelled cases (development / held-out splits)
tests/          offline test suite
Dockerfile      deployment container, secrets via .env, never in the image
compose.yaml    one-command deployment
```

## Quickstart

```bash
bun install
bun test && bun run typecheck

cp .env.example .env   # fill in tokens and model IDs
docker compose up --build
```
