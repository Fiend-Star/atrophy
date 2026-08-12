# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Atrophy is a local-first CLI (npm package `atrophy`) that measures a developer's unaided coding skill over time: short drills graded automatically, an Elo-style rating per skill axis, and a dashboard showing decay curves and the unaided-vs-AI-assisted gap. `PLAN.md` is the founding design doc and is still referenced from code comments (e.g. "PLAN §3.4").

## Commands

```sh
npm test                              # vitest run (all tests; spawns real python/node grading subprocesses)
npx vitest run engine/scoring.test.ts # one test file
npx vitest                            # watch mode
npm run typecheck                     # tsc --noEmit
npm run build                         # tsc -p tsconfig.build.json → dist/
npm run dev -- drill --show           # run the CLI from source (tsx); everything after -- is CLI args
npm run seed:demo                     # regenerate dashboard/demo-data.json
```

Requires Node ≥ 22 and Python 3 on `PATH` (Python exercises and their integrity tests actually run `python`). CI (`.github/workflows/ci.yml`) runs typecheck + test + build on ubuntu **and windows**, Node 22 and 24 — keep code Windows-safe (see the `SystemRoot`/`where` handling in `engine/runner.ts` and `engine/session.ts`, and filename-safe timestamps in `cli/index.ts`).

Useful env vars when developing: `ATROPHY_DB` (SQLite path override — point at a throwaway file, the default is the user's real `~/.atrophy/atrophy.db`), `ATROPHY_NO_SYNC=1` (kill-switch for all leaderboard network calls; set it whenever recording ai-off sessions in dev/tests so junk never reaches the public board), `ATROPHY_BANK`, `ATROPHY_PYTHON`, `ATROPHY_EDITOR`, `ATROPHY_CONFIG`, `ATROPHY_LEADERBOARD_URL`.

Interactive drills block on stdin/$EDITOR. For non-interactive runs use `--show` (preview, nothing recorded) or `--solution <file>` (grades a pre-written answer file; how the e2e-ish tests drive drills).

## Architecture

ESM throughout (`"type": "module"`, NodeNext): **relative imports use `.js` extensions even inside `.ts` files**. Strict TS with `noUncheckedIndexedAccess`. Tests are colocated `*.test.ts` next to their source; there is no vitest config file.

Data flows in one direction: `bank` (content) → `engine` (logic) → `store` (SQLite) → `cli` (orchestration + HTTP payload) → `dashboard` (rendering).

- **`bank/`** — exercise content. `schema.ts` is the single source of truth: a zod discriminated union on `kind` — `write`/`fix` (code vs hidden tests), `predict-output` (type the snippet's stdout), `cloze` (fill the blank), `outline` (self-scored rubric). Static exercises are one JSON file each under `bank/exercises/<axis>/`. `bank/generators/` holds generator *families* that render endless variants; the determinism contract is `generate(seed, tier)` must return an identical exercise for identical inputs, because the seed is embedded in the exercise id (`family-<6 hex>`) and replay rebuilds from it. `bank-integrity.test.ts` is the CI gate for content: every `fix` exercise's planted bug must actually fail a test, every `predict-output` snippet must run cleanly and deterministically, every cloze must contain `____`.

- **`engine/`** — all logic, no persistence. `scoring.ts`: Elo per axis (tiers act as fixed-rating opponents) plus Glicko-style RD — the core product invariant is **inactivity widens RD (confidence) but never lowers the rating; the rating only moves with drill evidence**. `select.ts`: picks the tier where predicted success is closest to 65%, mixes generator families (weighted 2×) with statics, avoids recently seen families. `session.ts`: the interactive drill loop per exercise kind — writes a solution file in a temp dir, opens `$EDITOR`, submit/resubmit/abandon via readline. `grader.ts`: emits Python/Node harness scripts that print `ATROPHY_RESULT <json>`; comparison is canonical-JSON equality. `runner.ts`: the sandbox — subprocess with no shell, minimal env, hard timeout, capped output. `rng.ts` (mulberry32), `guard.ts` (detect running AI assistants — warn, never block), `regression.ts`/`streak.ts`/`timeline.ts` (analytics precomputed for the dashboard).

- **`store/db.ts`** — better-sqlite3, two tables (`sessions`, `ratings`), idempotent `CREATE IF NOT EXISTS` migration. `getRating()` applies RD time-decay on read.

- **`cli/`** — commander entry point `cli/index.ts`; `drillOnce()` is the orchestrator tying select → guard → session → scoring → store → auto-sync. `serve.ts` `buildPayload()` is the **entire data contract** shared by `atrophy serve`, `atrophy export`, and the dashboard — change it and all three move together. `publish.ts` handles leaderboard opt-in and post-drill auto-sync (quiet on failure by design).

- **`dashboard/`** — a single self-contained HTML file, no build step, no CDN; it only draws what `buildPayload` precomputed. Deployed as a demo (with `demo-data.json`) to GitHub Pages by `.github/workflows/pages.yml`.

- **`leaderboard/`** — separate deployment: a Cloudflare Worker + D1 (`wrangler.toml`), not part of the npm package or CI.

## Invariants to preserve

- `--ai-on` sessions are recorded (for the divergence chart) but must **never touch the unaided rating** — that gap is the product's reason to exist.
- Generated exercise ids are `family-<6 hex seed>` and must reproduce exactly; in `resolveExercise` static bank ids win over generated-looking ids.
- Dual path resolution: the CLI runs from source (`cli/…` via tsx) and built (`dist/cli/…`), so asset lookups (`bankDir`, `dashboardHtmlPath`, `cliVersion`) try both `..` and `../..`. Anything new that loads a packaged asset needs the same treatment, and `package.json` `files` must include it.
- AI-off enforcement is honor-system: detect and warn, never block. Similarly, network failures during leaderboard sync must never interrupt a drill.

## Contributing exercises

The most common contribution: one JSON file under `bank/exercises/<axis>/`, id matching the folder's prefix scheme (e.g. `dbg-py-005`), validated by `bank/schema.ts` and gated by the integrity tests above. Run `npm test` before pushing — a broken exercise cannot merge.
