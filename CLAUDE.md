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
npx tsx cli/index.ts drill --lang java # same thing, but flags survive: npm (at least on Windows) eats the `--…` args after `--`, so `npm run dev -- drill --show --lang java` reaches the CLI as `drill` alone
npm run seed:demo                     # regenerate dashboard/demo-data.json
```

Requires Node ≥ 22 and Python 3 on `PATH` (Python exercises and their integrity tests actually run `python`). Java work additionally needs a JDK ≥ 21 (`javac`/`java`): every Java suite is wrapped in `describe.skipIf(!hasJdk())` and prints a "SKIPPED" warning, so **a green `npm test` without a JDK has not tested Java at all**. CI (`.github/workflows/ci.yml`) runs typecheck + test + build on ubuntu **and windows**, Node 22 and 24, with Python 3.12 and Temurin JDK 21 installed on every leg — keep code Windows-safe (see the `SystemRoot`/`where` handling in `engine/runner.ts` and `engine/session.ts`, and filename-safe timestamps in `cli/index.ts`).

Useful env vars when developing: `ATROPHY_DB` (SQLite path override — point at a throwaway file, the default is the user's real `~/.atrophy/atrophy.db`), `ATROPHY_NO_SYNC=1` (kill-switch for all leaderboard network calls; set it whenever recording ai-off sessions in dev/tests so junk never reaches the public board), `ATROPHY_BANK` (**replaces** the built-in bank dir), `ATROPHY_PACKS` (**additive** pack dirs, `path.delimiter`-separated — `;` on Windows), `ATROPHY_JAVA_HOME` (JDK override; `javac`/`java` are resolved as `$ATROPHY_JAVA_HOME/bin/…`, which is how you get past a `.cmd` shim from scoop/mise — the runner spawns without a shell and cannot execute one), `ATROPHY_PYTHON`, `ATROPHY_EDITOR`, `ATROPHY_CONFIG`, `ATROPHY_LEADERBOARD_URL`.

Validating an exercise pack — the content gate CI runs, pointed at the pack instead: `$env:ATROPHY_BANK="<pack-dir>"; npx vitest run bank/bank-integrity.test.ts`. `ATROPHY_BANK` **replaces** the bank, so this checks the pack alone and can only catch id collisions *within* it; a collision with a shipped exercise shows up in `atrophy doctor`, which loads base + packs merged.

Interactive drills block on stdin/$EDITOR. For non-interactive runs use `--show` (preview, nothing recorded) or `--solution <file>` (grades a pre-written answer file; how the e2e-ish tests drive drills).

## Architecture

ESM throughout (`"type": "module"`, NodeNext): **relative imports use `.js` extensions even inside `.ts` files**. Strict TS with `noUncheckedIndexedAccess`. Tests are colocated `*.test.ts` next to their source; there is no vitest config file.

Data flows in one direction: `bank` (content) → `engine` (logic) → `store` (SQLite) → `cli` (orchestration + HTTP payload) → `dashboard` (rendering).

- **`bank/`** — exercise content. `schema.ts` is the single source of truth: a zod discriminated union on `kind` — `write`/`fix` (code vs hidden tests), `write-harness`/`fix-harness` (Java-only behavioral drills: the exercise ships its own `testCode` harness plus a declared `totalChecks`, enforced at grade time), `predict-output` (type the snippet's stdout), `cloze` (fill the blank), `outline` (self-scored rubric), `recall` (short answer, numeric-tolerant — `1/4` == `0.25` == `25%`; optional `reveal` is shown after grading, never graded). Code-like kinds may set `submitPolicy: "single"` (whiteboard mode: one graded submission, no fix-and-resubmit loop; absent means "loop"). Static exercises are one JSON file each under `bank/exercises/<axis>/`. `loadBank` takes one dir or several (built-in bank + packs) and rejects a duplicate id across them. `bank/generators/` holds generator *families* that render endless variants; the determinism contract is `generate(seed, tier)` must return an identical exercise for identical inputs, because the seed is embedded in the exercise id (`family-<6 hex>`) and replay rebuilds from it. `generators.test.ts` pins every family's declared shape and a hash of one render, so editing a family's output is a deliberate act (it stops every recorded session from replaying to what the user saw); a family's `language` may be a concrete `Language` or `"any"` for language-agnostic drills. `bank-integrity.test.ts` is the CI gate for content: every `fix` exercise's planted bug must actually fail a test, every `predict-output` snippet must run cleanly and deterministically, every cloze must contain `____`.

- **`engine/`** — all logic, no persistence. `scoring.ts`: Elo per axis (tiers act as fixed-rating opponents) plus Glicko-style RD — the core product invariant is **inactivity widens RD (confidence) but never lowers the rating; the rating only moves with drill evidence**. `select.ts`: picks the tier where predicted success is closest to 65%, mixes generator families (weighted 2×) with statics, avoids recently seen families, and offers nothing it cannot grade — with no JDK, java exercises and families whose grading starts a JVM (`spawnsJvm`: the `JVM_KINDS` plus `predict-output`) drop out of `selectExercise` and `availableAxes`, while a java `cloze` stays (string-matched in-process). Inject `toolchains: { jdk }` to test either without probing the host; `hiddenByToolchain()` counts what the missing toolchain removed, which is what the CLI reports so the shrunken pool is never silent. `session.ts`: the interactive drill loop per exercise kind — writes a solution file in a temp dir, opens `$EDITOR`, submit/resubmit/abandon via readline. `grader.ts`: emits Python/Node harness scripts that print `ATROPHY_RESULT <json>`; comparison is canonical-JSON equality. Java instead compiles and runs a *shipped* harness: `javac` then `java` (two steps, so a compile error is reported as one, and compilation gets its own 30 s budget separate from the drill's `testTimeoutMs`), with `engine/java/Harness.java` (reflection over `Solution`, its own JSON codec mirroring `JSON.stringify` number semantics) for `write`/`fix`, and `engine/java/Atrophy.java` (`plan`/`check`/`report`/`watchdog`) beside the exercise's own `testCode` for the harness kinds. `predict-output` in Java skips `javac` entirely — single-file source launcher (`java Main.java`). `javatool.ts` owns JDK discovery (`ATROPHY_JAVA_HOME`, cached `hasJdk()` probe, `MIN_JDK_MAJOR = 21`, `parseJavaMajor`), the resource path lookup, and `JAVA_RUNTIME_FLAGS` — **six** pinned flags on every graded JVM: `-Dfile.encoding`, `-Duser.language`, `-Duser.country`, `-Duser.timezone`, `-Dstdout.encoding`, `-Dstderr.encoding` (the last two are not redundant: since JDK 19 `file.encoding` no longer covers a redirected `System.out`, which is exactly what grading reads). `runner.ts`: the sandbox — subprocess with no shell, minimal env, hard timeout, capped output. `rng.ts` (mulberry32), `guard.ts` (detect running AI assistants — warn, never block), `regression.ts`/`streak.ts`/`timeline.ts` (analytics precomputed for the dashboard).

- **`store/db.ts`** — better-sqlite3, two tables (`sessions`, `ratings`), idempotent `CREATE IF NOT EXISTS` migration. `getRating()` applies RD time-decay on read.

- **`cli/`** — commander entry point `cli/index.ts`; `drillOnce()` is the orchestrator tying select → guard → session → scoring → store → auto-sync. `bankDirs()` resolves the built-in bank (or `ATROPHY_BANK`) and appends `config.ts`'s `packDirs()` — `ATROPHY_PACKS` then `"packs"` from `~/.atrophy/config.json`, canonicalised and de-duplicated; a missing pack dir throws with the pack named. `doctor.ts` is the environment self-diagnosis (`checkJava` warns rather than fails — Python/JS drills are unaffected by a missing JDK). `serve.ts` `buildPayload()` is the **entire data contract** shared by `atrophy serve`, `atrophy export`, and the dashboard — change it and all three move together. `publish.ts` handles leaderboard opt-in and post-drill auto-sync (quiet on failure by design).

- **`dashboard/`** — a single self-contained HTML file, no build step, no CDN; it only draws what `buildPayload` precomputed. Deployed as a demo (with `demo-data.json`) to GitHub Pages by `.github/workflows/pages.yml`.

- **`leaderboard/`** — separate deployment: a Cloudflare Worker + D1 (`wrangler.toml`), not part of the npm package or CI.

## Invariants to preserve

- `--ai-on` sessions are recorded (for the divergence chart) but must **never touch the unaided rating** — that gap is the product's reason to exist.
- Generated exercise ids are `family-<6 hex seed>` and must reproduce exactly; in `resolveExercise` static bank ids win over generated-looking ids.
- Dual path resolution: the CLI runs from source (`cli/…` via tsx) and built (`dist/cli/…`), so asset lookups (`bankDir`, `dashboardHtmlPath`, `cliVersion`, `javaResourceCandidates`) try both `..` and `../..`. Anything new that loads a packaged asset needs the same treatment, and `package.json` `files` must include it (`engine/java` is there because the `.java` sources ship as-is — they are compiled on the user's machine, never by `tsc`).
- `engine/java/Harness.java` and `Atrophy.java` stay in the **unnamed package** — no `package` line, ever. Package-private invocation is the whole point: starter signatures are package-private, so `Harness` can only reach them (without `setAccessible`) by sharing the unnamed package with `Solution`.
- A harness reporting a different check count than the exercise declares is an exercise bug, never a score: `gradeHarness` replaces the result with a `harnessError` naming both numbers, and clamps `passed` into `[0, totalChecks]` before anything is rendered or stored. More generally, a `harnessError` is never evidence about the user — a missing JDK, a `javac` error, a broken exercise fixture, or a timeout in *any* language (a killed run prints no marker, so `parseMarker` reports one). So in the drill loop it does not consume a `submitPolicy: "single"` submission, does not print a score line (`0/n` would read as a verdict), and does not arm the `[s] stop here` option — which would otherwise let the user record a non-abandoned 0 and move the rating. The loop just re-prompts; the `--solution` path, having no loop, abandons instead.
- AI-off enforcement is honor-system: detect and warn, never block. Similarly, network failures during leaderboard sync must never interrupt a drill.

## Contributing exercises

The most common contribution: one JSON file under `bank/exercises/<axis>/`, id matching the folder's prefix scheme (e.g. `dbg-py-005`; the java statics are `sr-java-`/`dbg-java-`/`cr-java-`/`api-java-`/`dec-java-`, and the java generator families are `sr-java-cond`/`dbg-java-scan`/`cr-java-trace`/`api-java-blank`), validated by `bank/schema.ts` and gated by the integrity tests above. Run `npm test` before pushing — a broken exercise cannot merge.

Java authoring rules the harness enforces (each surfaces as a named grading error, not a crash — but the exercise is still wrong):

- `starterCode` keeps `public class Solution` with no `package` line. The graded method may be package-private (what the fixtures use — reflection reaches it via the shared unnamed package) or public, **never private**.
- The graded method must be unique by arity. Same name + same parameter count + different parameter types is rejected ("overloads are not supported"), inherited ones included; an *override* is fine — same signature twice collapses to the most-derived declaration, and synthetic bridge methods are skipped so a generic superclass does not read as a phantom overload.
- `Map` parameters must declare a literal `String` key type (`Map<String, Integer>`); JSON object keys are strings, so a wildcard, a type variable, or `Map<Integer, …>` is rejected.
- Integer values in `tests` stay within ±2^53. Java parses them exactly as `long`, but the exercise JSON goes through Node's `JSON.parse` first, so anything larger is already a different number before grading sees it.
- Every Java `starterCode` must **compile**: the integrity suite runs `javac` over each one and expects exit 0. A `fix`/`fix-harness` bug therefore has to be semantic (wrong bound, missed lock, lost update), never a syntax or type error.
- Harness kinds: `testCode` is a complete `public class Harness` with `main` that prints exactly one `ATROPHY_RESULT` line (use `Atrophy.plan`/`check`/`report`, and `Atrophy.watchdog(ms)` well under `testTimeoutMs` so a deadlock still reports), and its total must equal `totalChecks`.
- A harness must **always report**, including on the buggy starter it ships with. Integrity grades every harness starter and requires a real result (no `harnessError`): an exception that escapes `main` prints no marker line, which grades as a harness error rather than as the failure the drill is supposed to teach. So wrap the checks:

  ```java
  try { /* checks */ } catch (Throwable t) { Atrophy.check("harness crashed: " + t, false); } finally { Atrophy.report(); }
  ```
