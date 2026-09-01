# Expansion-1: the Aurora pack — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the FULL Aurora pack — every candidate the triage rules viable — as `atrophy-pack-aurora/` in Java-OAs (track `aurora`), plus the atrophy-side setup-polish task.

**Architecture:** Roster-first content pipeline (the proven Plan-D §4.24 pattern): scaffold → triage every candidate with rulings → authoring waves against the roster verbatim → consistency pass → whole-effort final review. One engine task runs parallel in the atrophy repo.

**Tech Stack:** atrophy exercise JSON (zod schema `bank/schema.ts`), Markdown manifest, vitest gates; TypeScript only in the setup-polish task.

**Spec:** `docs/superpowers/specs/2026-08-18-expansion-1-aurora-pack-design.md` (in the atrophy repo; the corpus and pack live in Java-OAs)

## Global Constraints

- **User order: FULL pack.** Triage leans *viable-with-constraint-clause* over *unusable*; every surviving row gets authored. Target the survey's upper range (~90–115 raw → ship everything that passes the stability filter).
- **Two repos.** Content: `C:\Users\gurms\IdeaProjects\Java-OAs` (branch `master`, push-direct). Engine polish + process docs: `C:\Users\gurms\IdeaProjects\atrophy` (branch `feat/java-language-support`).
- **Java-OAs staging discipline:** stage ONLY `atrophy-pack-aurora/` paths BY NAME (the repo carries unrelated dirty/untracked items — `git add -A` is forbidden).
- **Pack placement:** `atrophy-pack-aurora/` is a SIBLING of `atrophy-pack/`, never nested under a bank dir or another pack; dir basename never `all`/`base`.
- **Binding content conventions** (from DRILL-MANIFEST.md §4.24 + Plan B/C/D ledgers): the accepted set mirrors the prompt's framing (bare pinned form; the prompt's own unit suffixes; every offered form enumerated incl. bare-percent; 90≠0.9 collision check); tag-from-fact (doctrine recalls are `"any"`; a reveal may teach in Java on an any-tagged drill); word-prompt-to-match; mixed numerals never; constraint clauses recorded on the roster row. Engine facts: recall grading is case-insensitive, whitespace-collapsed (not stripped), numeric-tolerant at 1e-9 relative — an order-of-magnitude band or multi-clause answer CANNOT be a recall (outline instead).
- **Verify arithmetic independently — every numeric re-derived, never lifted.** This corpus's author warns figures drift; the sibling HRT corpus had 5/10 wrong stated answers; Plan D found two source defects. A stated answer is a hypothesis.
- **Stability split (binding):** SIGMOD-2017-anchored Aurora facts ship as durable recalls; moving service specs (replica counts, ACUs, I/O-Optimized, Global Database lag, 256 TiB) ship only with a date-stamp constraint clause in the prompt, or are ruled out. Named exclusions: "5x MySQL / 3x PostgreSQL" (source self-contradicts), comp/CSEP, pipeline dates, Bar-Raiser process trivia beyond the ~2 survey-named recalls.
- **Java authoring rules** (CLAUDE.md, enforced by integrity tests): `public class Solution`, no package line, compile-clean starters, graded method package-private or public and unique by arity, harness kinds print exactly one `ATROPHY_RESULT` with `Atrophy.watchdog` + try/catch/finally-report, `totalChecks` exact, planted bugs semantic and provably failing.
- **Gates:** `$env:ATROPHY_BANK="<aurora pack>"; npx vitest run bank/bank-integrity.test.ts` green (run from the atrophy repo); merged doctor (base + DE Shaw pack + aurora via `ATROPHY_PACKS`) zero collisions + track table shows `aurora`; every graded drill's reference solution scores 1.00 through the real CLI with scratch `ATROPHY_DB` + `ATROPHY_NO_SYNC=1`.
- **Id scheme:** slugs prefixed `aur-`; JSON under `atrophy-pack-aurora/exercises/<axis>/<slug>.json`.
- Commits end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Pack scaffold + manifest skeleton

**Files (Java-OAs):**
- Create: `atrophy-pack-aurora/pack.json` — exactly `{"name": "aurora", "description": "AWS control-plane & Aurora internals (2026 corpus)"}`
- Create: `atrophy-pack-aurora/MANIFEST-AURORA.md` — header + §1 "How to read" (mirroring DRILL-MANIFEST.md §1's source-code/axis/kind/build-status conventions, adapted: source codes A00–A08 + AS1–AS5 for the sixteen corpus files), empty §2 (roster, filled by Task 2), empty §9 (build status)
- Create: `atrophy-pack-aurora/exercises/` axis dirs as needed (may start empty except one smoke drill)
- Create: one smoke recall `exercises/api-memory/aur-smoke-quorum.json` — prompt "In Aurora's storage layer, a write must be acknowledged by how many of the six segment copies?", acceptedAnswers `["4", "4/6", "4 of 6"]` (enumerate per convention), language `"any"`, tier 1, reveal citing the 4-of-6 write / 3-of-6 read quorum design. This row is re-ruled by Task 2's roster (slug may be renamed `aur-quorum-write`).

- [ ] **Step 1:** Create the four items above.
- [ ] **Step 2:** Gate: from the atrophy repo, `ATROPHY_BANK=<aurora pack abs path> npx vitest run bank/bank-integrity.test.ts` → green (1 drill); then with `ATROPHY_PACKS=<DE Shaw pack>;<aurora pack>` run `npx tsx cli/index.ts doctor` → zero collisions, track table lists `aurora  1 drills`.
- [ ] **Step 3:** Commit (Java-OAs, staged by name): `feat(pack-aurora): scaffold — pack.json, manifest skeleton, smoke drill`.

### Task 2: Triage roster — every candidate ruled (the §4.24 of this pack)

**Files (Java-OAs):**
- Modify: `atrophy-pack-aurora/MANIFEST-AURORA.md` (§2 roster)

**The read:** ALL five in-scope files IN FULL — `03_Coding_Rounds.md`, `04_System_Design_and_LLD.md`, `05_Aurora_and_Control_Plane_Domain.md`, `sources/01_Master_Prep_Doc.md` (§6 only), `sources/04_Recruiter_Screen_Prep.md` (launch facts only) — plus a skim of `07_Phone_Screen_Aug2026.md` for its ~2 survey-named net-new recalls.

**Roster columns:** slug (`aur-…`) · source (file §) · kind · axis · language · tier · stability class (SIGMOD-anchored / date-stamped / excluded) · dup-risk vs base+DE Shaw pack · ruling (viable / viable-with-constraint / unusable + one-line reason) · constraint clause verbatim where applicable.

**Rulings the roster MUST contain explicitly** (survey-named): p70-vs-`find-median-data-stream` differentiation (windowed + memory-bounded angle); idempotency-store vs shipped `execid-dedup` (differentiate or fold); the LLD pattern-dressing skips (notification router, vending machine); HashMap/heap internals skip (covered); the two false positives (CME "Aurora" datacenter; `td-recon-breaks`) noted as non-collisions; the "5x/3x" exclusion; every moving-spec row's date-stamp clause. FULL-pack lean: a row is `unusable` only for a named mechanism (no single defensible answer, grading cannot express it, duplicate, or excluded class) — "weak" is not a mechanism.

- [ ] **Step 1:** Read the five files completely; build the roster.
- [ ] **Step 2:** Sanity: roster totals by kind reported vs the survey's estimate (recall ~55–70 raw, outline ~20–26, write 8–11, fix 3–5, cloze 3–5); any large deviation explained row-by-row, not hand-waved.
- [ ] **Step 3:** Commit: `docs(pack-aurora): triage roster — all candidates ruled`.

### Task 3: Recall wave A — Aurora storage + operational canon (file 05)

**Files (Java-OAs):** create `exercises/<axis>/aur-*.json` for every viable `recall` roster row sourced from `05`; update each roster row to `shipped wave A (<commit>)`.

- [ ] **Step 1:** Author every wave-A row per the conventions; every numeric re-derived; reveals cite the doctrine (SIGMOD paper facts, AWS builders-library concepts) in the drill's own words.
- [ ] **Step 2:** Self-verify: a table in the task report — row → accepted forms → derivation/citation → convention check.
- [ ] **Step 3:** Gate: pack-only bank-integrity green; spot-grade 3 drills through the real CLI (`--exercise aur-…  --solution` with scratch DB + NO_SYNC) at 1.00 for the keyed answer and 0 for a plausible impostor.
- [ ] **Step 4:** Commit: `feat(pack-aurora): recall wave A — storage + operational canon (N drills)`.

### Task 4: Recall wave B — arithmetic, launch facts, p70 numerics (files 04, 03, sources/01 §6, sources/04, 07 net-new)

Same steps and gates as Task 3, for the remaining viable recall rows. Arithmetic rows (100k writes/s → 8.64B/day → ~200 GB/day; 13.9 adds/s, n≈833, ~8,100 comparisons) are recomputed from the stated inputs in the task report — a mismatch with the corpus ships the RECOMPUTED value and notes the source defect on the roster row (Plan-D precedent). Commit: `feat(pack-aurora): recall wave B — arithmetic + launch facts (N drills)`.

### Task 5: Outline wave — the sixteen questions + the seven-point template

**Files (Java-OAs):** create every viable `outline` roster row (`05` §5, `04` §4).

- [ ] **Step 1:** Author with rubrics whose bullets quote/paraphrase §1–§4 of the source file (source-anchored, 4–7 bullets each, no invented criteria); language `"any"`; axis decomposition.
- [ ] **Step 2:** Gate: pack-only bank-integrity green (outlines parse; rubric arrays non-empty).
- [ ] **Step 3:** Commit: `feat(pack-aurora): outline wave — control-plane design questions (N drills)`.

### Task 6: Graded Java — the p70 family

**Files (Java-OAs):** the roster's `03`-sourced graded rows — expected shape: `aur-p70-window-write` (write: `add(long ts, double v)` / `getP70()` over a 60s window; ≥6 json-tests incl. window-eviction and duplicate-value cases), one variant (ring-buffer or quickselect angle, write or write-harness per roster), 3–4 `fix` drills planted from §2.3's defect table (each starter compiles, each planted bug semantic and failing ≥1 test).

- [ ] **Step 1:** Author; every starter compiled locally (`javac`) and every reference solution graded 1.00 through the real CLI; every fix starter graded <1.00 with the planted bug and 1.00 fixed.
- [ ] **Step 2:** Gate: pack-only bank-integrity green (it compiles starters and runs planted-bug checks for real — JDK required).
- [ ] **Step 3:** Commit: `feat(pack-aurora): graded java — p70 family (N drills)`.

### Task 7: Graded Java — control-plane primitives

Same steps/gates as Task 6 for: fencing-token guard, idempotency store (per roster ruling vs `execid-dedup`), reconciliation diff (desired vs observed → action list), shuffle-shard assignment with overlap assertion — `write` or `write-harness` per roster; harness kinds follow the Atrophy.plan/check/report + watchdog rules exactly. Plus the cloze remainder (D6 rows, tagged `java`, string-matched — no toolchain). Commit: `feat(pack-aurora): graded java — control-plane primitives + cloze (N drills)`.

### Task 8: Consistency pass + build status

**Files (Java-OAs):** `MANIFEST-AURORA.md` §9 build-status (Plan-D §9.8 style: per-task commits, drill counts, reconciliation arithmetic, corrections-not-recorded list); a wording sweep across all shipped prompts (accepted-set convention spot-audit on 10 random rows; uniform date-stamp clause wording; slug/title/roster agreement both directions — every `shipped` row has a file, every file has a row).

- [ ] **Step 1:** Sweep + fix inconsistencies; recount.
- [ ] **Step 2:** Full merged gate: pack-only bank-integrity green; merged doctor zero collisions with the final drill count; 5 random drills re-graded through the CLI.
- [ ] **Step 3:** Commit: `docs(pack-aurora): build status + wording sweep`.

### Task 9 (atrophy repo, parallel-safe): setup polish

**Files (atrophy, branch `feat/java-language-support`):**
- Modify: `cli/setup.ts`, `cli/setup.test.ts`

Closes final-review M2–M4: (1) interactive out-of-range numeric pick (e.g. "5" with 4 languages, or a track number past the list) re-prompts instead of silently writing "all"; (2) interactive refuses to persist an ambiguous track name — prints the ambiguity and re-prompts; (3) `--show` with setter flags prints `ignoring --languages/--track (--show never writes)`. One test each (scripted SetupIO with a bad answer then a good one; ambiguous two-pack fixture; show+setter). TDD per repo convention; `npx vitest run cli/setup.test.ts` + typecheck; commit `fix(cli): setup polish — strict picks, no ambiguous writes, loud --show`.

---

**Final:** Fable whole-branch review over BOTH diffs (Java-OAs pack commits; atrophy T9 commit), one fix dispatch + scoped re-review if needed, then push Java-OAs master, push atrophy branch, update PR bodies if T9 landed, close the ledger.
