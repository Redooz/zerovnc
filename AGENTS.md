# AGENTS.md

## Verify

- `bun run typecheck && bun test` — the only checks that exist (no lint/format script). Tests are deterministic and make zero network calls; do not add tests that hit OpenRouter.
- ESM + Bun everywhere. Strict tsconfig: imports need `.ts` extensions (`allowImportingTsExtensions`), `noUncheckedIndexedAccess` and `verbatimModuleSyntax` are on. Bun pinned at 1.4.2 (matches `bun.lock` and the Docker image).

## Architecture: hexagonal, enforced

- Dependency direction: `src/domain` → `src/application` → `src/adapters` → `src/bootstrap`. Domain and application must not import adapter types. New outbound capability = port in `src/application/ports`, adapter under `src/adapters/outbound/`, wiring in `src/bootstrap/main.ts` (the composition root and HTTP server).
- Entry points: server = `src/bootstrap/main.ts`; CLI scripts live in `src/bootstrap/` and `evals/`, exposed via package.json scripts (`timeline`, `diagnose`, `bench:*`).
- Only the agent loop sets task status `terminada`/`fallida` — always from verification evidence, never from a model's claim of success. Cross-cutting changes to this invariant need care: tools dispose, the loop decides.

## Model calls and prompts

- All model traffic goes through OpenRouter only. Model IDs and thresholds live in env/config (`src/bootstrap/models.ts`, see `.env.example`); changing a model must pass the component evals.
- Prompts are versioned files read at runtime from `src/adapters/outbound/openrouter/prompts/` and `src/adapters/outbound/pi/prompts/` — editing a prompt means bumping its version; the version is recorded per trace event.
- Counting, date arithmetic, and grounding thresholds are computed in code, not by the model.

## Env and runtime data

- `.env` is required at startup (copy `.env.example`). Every HTTP endpoint needs `Authorization: Bearer $AGENT_BEARER_TOKEN`.
- Running the agent creates real side effects: `data/agent.sqlite` events and screenshots/transcripts under `artifacts/`. Both plus `reports/` and `diagnostics/` are gitignored — don't commit them.
- Secrets must never appear in traces, summaries, or learned UI notes; storage redacts — keep that true when touching trace/storage code.

## Evals (not just `bun test`)

- `bun run eval` drives a **live** agent at `EVAL_AGENT_URL` through a real remote desktop (`EVAL_*` vars in `.env`); it resets desktops and grades app state. Without those endpoints/tokens it can't run — it is not part of `bun test`.
- Offline component benches with labelled cases live in `evals/bench/` (the `bench:*` scripts) and mirror tests under `tests/evals/`. Graders are in `evals/graders/`; fixtures in `evals/fixtures.ts`.
- Test doubles (no network) live in `tests/support/` — reuse `fakeDesktop`/`agent-doubles` before inventing new ones.

## Repo quirks

- Task deadline is hard: `TASK_TIMEOUT_MS` (challenge budget is 5 minutes); the eval runner assumes the same limit.
- `design/` contains only local, gitignored planning docs (`design/*plan*.md`) — architecture context is stated in README.md and the code itself.
- Deploy is `docker compose up --build`; the image installs deps only from the frozen lockfile and gets secrets at runtime, never in the image.
