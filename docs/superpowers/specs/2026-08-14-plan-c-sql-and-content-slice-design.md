# Plan C: SQL Modality + Curated Content Slice — Design

**Date:** 2026-08-14
**Status:** Approved in brainstorming (three scope decisions + Approach 1 + three design sections), pending user review of this written spec.
**Predecessors:** Plan A (java engine, `docs/superpowers/specs/2026-08-13-java-language-support-design.md`) and Plan B (java content, ledger `.superpowers/sdd/2026-08-13-java-content-plan-b/progress.md`). Plan B's execution rulings — N−1 harness totals, the verbatim catch-all/report idiom, the default-satisfiability ban, the deadline-race rule, 0/N-by-running — **bind this plan's content**; where this spec and a Plan B ruling conflict, the ruling wins unless this spec explicitly supersedes it (it never does).

## 1. Goal and framing

Plan C ships (a) every engine enabler still owed after Plan B — headlined by a SQL grading modality on `better-sqlite3` — and (b) a curated ~90-drill content slice: the highest-value remainder of the DeShaw manifest plus breadth picks.

**Framing guardrail (standing):** atrophy is a measurement instrument for skill decay, not a problem archive. The manifest's ~650 remaining rows are inventory to curate from, never a completion target. Later waves (Plans D, E, …) are mechanical content-only plans reusing this machinery; no further engine spec is anticipated for them.

**User decisions recorded:** scope = enablers + top slice (not engine-only, not all-of-wave-2); SQL grading = both, split by drill (behavioral execution for query-writing, recall/cloze for syntax facts); slice = ~90 "value + breadth" (the ~70 value-first core plus ~20 wave-3 picks for code-reading/debugging coverage); SQL engine shape = Approach 1 (language on the existing `write` kind, no new kind).

## 2. SQL modality

### 2.1 Schema (`bank/schema.ts`)

- `LANGUAGES` gains `"sql"`: `["python", "javascript", "java", "sql"] as const`.
- In the same change, the grader's JVM-kind list folds into schema.ts as the ruled typed export: `export const JVM_KINDS = ["write", "fix", "write-harness", "fix-harness"] as const` with a `JvmKind` type; existing consumers (grader, integrity suite) import it instead of re-declaring.
- The `write` arm stays the single union arm for its kind (Approach 1: no new `kind`). Its shape widens:
  - `functionName` and `tests` become optional in the raw shape;
  - new optional fields `cases` and `ordered` are added:
    - `cases: z.array(z.object({ fixture: z.string().min(1), expectedRows: z.array(z.record(z.string(), z.unknown())) })).min(2)` — `fixture` is one string of DDL + seed `INSERT`s; `expectedRows` is the exact JSON row array (objects keyed by output column name, which makes required aliases part of the problem);
    - `ordered: z.boolean().optional()` — absent or false, row order is ignored at comparison; sql-only (exact optional-vs-default zod mechanics are the plan's call, but absent must mean unordered).
  - a `superRefine` restores strictness — **no field is optional in practice**:
    - `language === "sql"` ⇒ `cases` present (min 2 enforced by the array schema), `tests` and `functionName` absent;
    - `language !== "sql"` ⇒ `tests` and `functionName` present (exactly today's contract), `cases` and `ordered` absent;
    - additionally: at least two entries of `cases` differ in canonical `expectedRows` (the anti-hardcode gate, see §2.4).
- SQL is **forbidden** everywhere else that executes or repairs code: refinements reject `language === "sql"` on `fix` and `predict-output`. Harness arms already pin `language: "java"`. `cloze` inherits sql legitimately via the `LANGUAGES` enum (string-matched, nothing executes). `recall` is `language: "any"` and needs no change — SQL syntax-fact recall drills are plain recall exercises.
- New narrowing helper + type: `isSqlWrite(ex): ex is SqlWriteExercise` (write ∧ language "sql"); `CodeExercise` consumers that read `tests` branch through it. `totalUnits` for `write` returns `ex.cases.length` when sql, `ex.tests.length` otherwise.

### 2.2 Grader (`engine/grader.ts`)

New emit branch on the existing JS lane (same runner, same marker protocol):

- The emitted Node script `require`s better-sqlite3 **by absolute path**, resolved at emit time via `createRequire(import.meta.url).resolve("better-sqlite3")` and JSON-stringified into the script — the temp dir the script runs from cannot resolve the package by name. This works from both source (`tsx`) and `dist/` because node_modules sits at the package root either way; better-sqlite3 is already a production dependency (the store), so nothing new ships.
- Per case, the script: opens a fresh `new Database(":memory:")`; `db.exec(fixture)`; sets `PRAGMA query_only = 1` (hardening; the DB is throwaway regardless); reads the submitted file's text and runs `db.prepare(sql).all()` — `prepare` accepts exactly one statement, so multi-statement submissions fail as a named case error, not silently.
- Comparison reuses the grader's canonical-JSON equality (sorted object keys, `JSON.stringify` number semantics). When `ordered` is false, both actual and expected row arrays are sorted by each row's canonical JSON string before comparison, so row order and column order are both immaterial; when true, row order must match.
- A per-case thrown error (syntax error, missing table, write attempt under `query_only`) fails that case with the error message as the failure detail; remaining cases still run. The script always prints exactly one `ATROPHY_RESULT` line with `{ passed, total, failures }` in the json-tests result shape; score is `passed / cases.length`. All existing hostile-marker hardening applies unchanged.
- Timeouts: the existing `testTimeoutMs` default (10s) is ample; no SQL-specific floor.

### 2.3 Session, CLI, doctor

- `solutionFileName` gains a `.sql` case; the solution file opens in `$EDITOR` pre-seeded with `starterCode` (conventionally a `-- prompt recap` comment plus an optional partial query).
- Drill prompts for behavioral SQL state the dialect: **SQLite** (window functions included; the bundled better-sqlite3 SQLite is modern). Exercises must not depend on MySQL-isms.
- `doctor` reports sql as always available, naming the bundled better-sqlite3; there is no toolchain probe to fail.
- The submit/resubmit loop, `--show`, `--solution`, `submitPolicy` semantics: unchanged — sql `write` behaves like any hidden-tests drill.

### 2.4 Integrity gates (in `bank/bank-integrity.test.ts`, applying to every sql write in bank or pack)

1. Mechanical gates needing no reference solution (references live in briefs, not exercise JSON — Plan B discipline): (a) every `fixture` applies cleanly to a fresh DB; (b) ≥ 2 cases differ in canonical `expectedRows` (schema-enforced, re-asserted here against the loaded bank); (c) the auto-constructed hardcode cheese — a `SELECT … UNION ALL …` literal query rebuilt from the first case with non-empty `expectedRows` (all-empty cases already fail gate b) — must **fail** at least one other case; (d) determinism: any case's fixture applied twice and queried twice with a canary `SELECT` yields identical rows. `expectedRows` values are JSON scalars (SQLite integer/real/text/NULL); BLOB is out of scope.
2. Reference-grading stays mandatory in every authoring brief (Plan B ruling): the implementer must grade their reference query to 1.00 through the real CLI before commit, and the task reviewer re-derives expected rows by hand. The suite cannot see references; the process supplies that net.
3. The Task-17 vacuity guard splits per-kind (§3.5) and gains a sql arm in the same commit that lands built-in sql statics: for the built-in bank, `javaCode > 0`, `javaPredicts > 0`, and `sqlWrites > 0`.

### 2.5 Non-goals

No sql `fix`, `predict-output`, or harness kinds; no query-plan grading; no MySQL/Postgres dialect layers; no per-statement sandboxing beyond `query_only` + fresh in-memory DBs; no SQL generator family in this plan.

## 3. Engine decisions (CARRY items, each ruled)

### 3.1 Scan-weighted scoring — **no engine change**
Uniform check weights stand. Binding authoring convention instead: scans are conjunctive gates (their job is 0/N starters and unprofitable cheeses), each drill's scan-check count ≤ its behavioral-check count, totals stay N−1 style. Rationale: weighted scoring complicates the `totalChecks` grade-time invariant for negligible measurement gain.

### 3.2 Multi-blank cloze — **extend the kind, back-compat mandatory**
`cloze` may contain N ≥ 1 `____` blanks. `acceptedAnswers` widens to a union: `string[]` (existing single-blank shape, untouched — every shipped cloze stays valid byte-for-byte) or `string[][]` (one accepted-set per blank, length must equal the count of `____` occurrences in `snippet` — schema-refined and integrity-re-asserted). Scoring: `blanksCorrect / totalBlanks` (partial credit; `totalUnits` returns the blank count). The session prompts once per blank, in order. Grading stays in-process.

### 3.3 Generator language widening
`ExerciseGenerator.language: Language` widens to `Language | "any"` (`bank/generators/types.ts`). Selection and `availableAxes` treat `"any"` as matching every requested language. No existing family changes; determinism is untouched (`rngFor` keys per family).

### 3.4 Toolchain-aware selection
`select.ts` filters out exercises and families whose grading toolchain is absent — concretely: everything `language === "java"` (all java kinds spawn a JVM, predict-output included) when `hasJdk()` is false. Python/JS behavior untouched; sql exempt by construction. The guard/doctor warn path remains for everything else.

### 3.5 Vacuity guard per-kind split
The built-in-bank presence check becomes three arms: `javaCode.length > 0`, `javaPredicts.length > 0`, `sqlWrites.length > 0` — the sql arm landing in the same commit as the first built-in sql statics (never before, or the gate fails on truth).

### 3.6 Authoring-convention carries (bind briefs; no code)
Recall prompts state the expected answer form ("number only" — L154). Pack drills must not verbatim-duplicate facts the built-in bank drills (the a02/a05/a10 class): reframe or move to a different surface, with a per-row note in the brief. `api-java-005` ships as-is; a wave-2 sibling covers get()-creates-key through a `keys()` surface. Non-uniform per-key counter targets and the stamped-treiber mixed-phase note apply to the concurrency drills inheriting them. Any slice row carrying the manifest's R08 checksum annotation ships computed values, never the source doc's printed ones.

## 4. Content slice (~90; curation not completion)

Composition (dedupe via the manifest's own dedupe log plus explicit overlap rulings in briefs; target lands ~85–92):

1. **13 SQL pack drills** (manifest §5.1, wave X → unblocked): ~8 behavioral `write` (incl. `sql-consecutive-numbers` — freq 2, confirmed CodePair — and `sql-second-highest-salary`, whose merged-pair acceptance of both subquery and `DENSE_RANK` forms falls out of behavioral grading naturally) and ~5 recall/cloze syntax-fact drills (`DENSE_RANK` vs `RANK` vs `ROW_NUMBER`, `LAG`/`LEAD`, `PARTITION BY`), split per drill at authoring against the manifest's notes.
2. **2–3 built-in sql statics** on generic, non-DeShaw schemas (a group-by/having drill, a window-function drill, optionally a join/anti-join drill) — the shipped bank must exercise its own lane, and they feed the guard's sql arm.
3. **All 39 frequency-confirmed wave-2 rows** (6 at freq ≥ 3, 19 at freq 2, the rest freq-annotated).
4. **The 7 named W2 concurrency build drills**: `prodcons-waitnotify`, `bounded-blocking-queue`, `singleton-five-ways`, `chm-internals-explain`, `c04-readwritelock-jdk`, `reentrantlock-vs-sync`, `happens-before-six`. `bounded-blocking-queue` gets an explicit overlap ruling against the shipped built-in `dec-java-005` bounded queue before authoring.
5. **The 12 wave-2 `recall` rows** — the recall kind's first shipped content. Separately, the multi-blank capability (§3.2) restores the a04/a10-class per-table cloze coverage that single-blank forced out of wave 1.
6. **~20 top wave-3 DERIVED picks**, weighted to code-reading and debugging (wave 2 has one row each); the exact list is frozen at plan-writing from manifest order-of-value and named in the plan, not chosen ad hoc mid-execution.

**Exclusions regardless of value:** all NEEDS-AUTHORING rows (editorially blocked; they keep their wave for a later plan); anything the dedupe log already folded.

## 5. Testing strategy

- **Engine work is TDD**: schema refinements (sql shape legal/illegal matrix, multi-blank length rule, back-compat fixtures), grader sql branch (pass/fail/ordered/unordered/multi-statement/error-per-case/marker shape), cloze multi-blank scoring, selection filtering (JDK present/absent), guard split. Colocated `*.test.ts` as throughout.
- **Content is integrity-gated**: §2.4 sql gates + existing gates extended mechanically to new content; every Plan B convention gate stays.
- **Wrap smoke** (built CLI, throwaway DB, `ATROPHY_NO_SYNC=1`): existing per-family spot-grades plus one behavioral sql drill (reference 1.00, wrong-query < 1.00, hardcode-cheese fails) and one multi-blank cloze (partial credit observed).
- **Docs**: README five-skills table reconciled with shipped kinds (deferred Plan B carry), sql modality documented, CLAUDE.md bank/engine notes updated.

## 6. Execution notes

Same SDD machinery as Plan B: new plan doc via writing-plans; fresh workspace ledger; engine tasks first (they gate all content), content tasks parallelized by axis/family in worktrees (verify-base-first clause retained), wrap task last. Opus for implementers/reviewers; Fable only for the final whole-branch review (and content only-if-defeated). Pack commits in Java-OAs stage only `atrophy-pack/exercises` files by name. `ATROPHY_NO_SYNC=1` + throwaway `ATROPHY_DB` for anything that records. Both repos' final state gets the whole-branch review before push; atrophy pushes update PRs #1/#38.

## 7. Out of scope

Waves D/E (wave-2 remainder ~200 rows, wave-3 remainder ~300), NEEDS-AUTHORING editorial work, SQL generator families, LLM-judged outline grading (v2 per schema comment), any leaderboard changes.
