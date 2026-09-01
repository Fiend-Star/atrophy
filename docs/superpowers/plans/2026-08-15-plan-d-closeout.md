# Plan D Closeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the java/sql effort's consolidated backlog: language mix soft-cap, CLI importability, README drift guard, base recalls + sr-sql-001 case, ~8 SQL joins pack drills, full recall-backlog triage + authoring, wording pass. Final plan — everything ships or is closed with a ruling.

**Architecture:** Engine changes are additive and behind optional inputs (absent = today's behavior). Content follows Plan C's manifest-row-as-requirement convention. Order matters: base-bank content (Task 3) lands before the drift guard (Task 4) so the guard's fixture is born current.

**Tech Stack:** TypeScript ESM (NodeNext, `.js` imports), vitest, zod, better-sqlite3, commander.

**Spec:** docs/superpowers/specs/2026-08-15-plan-d-closeout-design.md

## Global Constraints

- All subagent seats run on **Fable** (user order — final plan).
- Any CLI run that could record a session: `ATROPHY_NO_SYNC=1` + `ATROPHY_DB` → throwaway file in the agent scratchpad. Never the real `~/.atrophy/atrophy.db`.
- Pack commits stage ONLY `atrophy-pack/exercises/...` and `atrophy-pack/DRILL-MANIFEST.md`, by name. Never `git add -A` in Java-OAs.
- Windows: `npm run dev --` swallows flags — drive the CLI with `npx tsx cli/index.ts …`.
- Every authored/edited drill is reference-graded 1.00 through the real CLI; command + score recorded in the task report.
- Binding content rules from the Plan B/C ledgers (spec §Binding content rules) apply to every content task.
- Commits end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Product invariants (spec §Gates): ai-on isolation, harnessError-never-evidence, RD-widens-rating-never-decays, generator determinism (NO generator family output may change in this plan).
- Per-task gates: `npm run typecheck`; `npm test` (JDK present — zero "SKIPPED" java warnings tolerated); pack tasks additionally `$env:ATROPHY_BANK="C:\Users\gurms\IdeaProjects\Java-OAs\atrophy-pack\exercises"; npx vitest run bank/bank-integrity.test.ts` and a merged `npx tsx cli/index.ts doctor` (expect 0 collisions, 0 warnings).

---

### Task 1: Language mix soft-cap

**Files:**
- Modify: `engine/select.ts` (SelectOptions + weighted pick)
- Modify: `store/db.ts` (recentSessionLanguages helper)
- Modify: `cli/index.ts` (drillOnce wiring)
- Test: `engine/select.test.ts`, `store/db.test.ts`

**Interfaces:**
- Produces: `SelectOptions.recentLanguages?: (Language | "any")[]` (most-recent-first); `recentSessionLanguages(db: Database, n: number): (Language | "any")[]`.
- Consumes: existing `selectExercise` weighted pick (generator 2× weighting).

- [ ] **Step 1: Failing engine tests.** In `engine/select.test.ts` add (fake toolchains, seeded rng, a bank with java + python + any candidates on one axis/tier):

```ts
// Policy triggers: java holds >= 3 of the 6-window -> java candidates weight x0.25.
// With a seeded rng sweep of 400 draws, java's share drops below python's share;
// without recentLanguages the same sweep is language-balanced (sanity bound, not exact).
test("dominant recent language is soft-capped", ...)
test("explicit language bypasses the cap", ...)        // language: "java" -> java still served normally
test("all-dominant pool still serves", ...)            // pool = only java candidates -> still returns one
test("any-language candidates are never penalized", ...)
test("absent recentLanguages preserves existing behavior", ...) // draw-for-draw vs pre-change with same seed
```

- [ ] **Step 2: Run to verify failure** (`npx vitest run engine/select.test.ts`).
- [ ] **Step 3: Implement.** `recentLanguages` per spec E1: window = first 6 entries; concrete `L` with count ≥ 3 ⇒ ×0.25 multiplier on `L`-candidates in the weighted pick, composing with the generator 2× weight; renormalize; apply only when `language === undefined`; `"any"` exempt.
- [ ] **Step 4: Failing store test:** `recentSessionLanguages` returns last-n session languages most-recent-first (insert 8 sessions across languages, expect the ordered last 6; empty db → `[]`).
- [ ] **Step 5: Implement the helper** (single indexed query on `sessions` by recency), wire `drillOnce` to pass `recentLanguages: recentSessionLanguages(db, 6)` ONLY when the user gave no `--lang`.
- [ ] **Step 6: Gates.** `npm run typecheck && npm test`.
- [ ] **Step 7: Commit** `feat(select): soft-cap a recent-dominant language when no --lang is given`.

### Task 2: CLI importability

**Files:**
- Modify: `cli/index.ts` (entry guard + exports)
- Test: `cli/importable.test.ts` (create)

**Interfaces:**
- Produces: importing `cli/index.ts` is side-effect-free; exports `drillOnce` and each command action function.
- Consumes: Task 1's wiring (preserve it verbatim through the refactor).

- [ ] **Step 1: Failing test** (`cli/importable.test.ts`): dynamic-import `./index.js`; assert no `process.exit`, no stdout parse output (spy), and `typeof mod.drillOnce === "function"`.
- [ ] **Step 2: Run to verify failure** — today the import parses argv.
- [ ] **Step 3: Implement.** Wrap registration+`program.parse` in `runCli()`; call it only when entry: `process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href` (try/catch the realpath). Export `runCli`, `drillOnce`, action fns. Zero behavior change when run as a command.
- [ ] **Step 4: Verify both run paths.** `npx tsx cli/index.ts doctor` works; `npm run build && node dist/cli/index.js doctor` works (dual-path invariant).
- [ ] **Step 5: Gates + commit** `refactor(cli): import-safe entry — commands run only when index.ts is the process entry`.

### Task 3: Base recalls + sr-sql-001 discrimination case

**Files:**
- Create: 6-8 recall JSONs under `bank/exercises/<axis>/` (ids per axis prefix scheme)
- Modify: `bank/exercises/<axis>/sr-sql-001.json` (add one case)
- Test: existing integrity suites (no new test files)

**Requirements:** spec C1+C2. Recall facts must be durable and universal (canonical complexity facts, cold-recall language gotchas); concrete `language` tag iff the fact presupposes one; numeric tolerance shapes; optional teaching `reveal`. sr-sql-001: add a case where `COUNT(col)` ≠ `COUNT(DISTINCT col)`; existing cases byte-identical.

- [ ] **Step 1: Author the recalls** (schema-validated as you go: `npx vitest run bank/bank.test.ts bank/bank-integrity.test.ts`).
- [ ] **Step 2: sr-sql-001 case** + integrity re-run (UNION-cheese + determinism gates must pass on the new case).
- [ ] **Step 3: Reference-grade every drill 1.00** through `npx tsx cli/index.ts drill --exercise <id> --solution <file>` (NO_SYNC + throwaway DB); record commands + scores.
- [ ] **Step 4: Gates + commit** `feat(bank): base recall set + sr-sql-001 COUNT DISTINCT case`.

### Task 4: Five-skills-table drift guard

**Files:**
- Create: `cli/readme-claims.test.ts`

**Requirements:** spec E3. Compute per-axis offerable-kind sets and the `--lang` rule from the built-in bank + generator registry; compare against a literal fixture commented "mirrors README five-skills table — update BOTH together"; failure message names the README section. No README parsing. Runs after Task 3 so the fixture is born current.

- [ ] **Step 1: Write the test with a deliberately wrong fixture; verify it fails naming the README.**
- [ ] **Step 2: Correct the fixture from measured output; verify green.** Cross-check the fixture against README's actual table by reading it — if the README is already wrong, fix the README in this task.
- [ ] **Step 3: Gates + commit** `test(cli): pin the README five-skills table to measured selection behavior`.

### Task 5: SQL joins set (8 pack drills)

**Files:**
- Modify: `C:\Users\gurms\IdeaProjects\Java-OAs\atrophy-pack\DRILL-MANIFEST.md` (new rows FIRST — the row is the requirement)
- Create: 8 sql `write` JSONs under `atrophy-pack/exercises/`

**Requirements:** spec C3 coverage list (inner-vs-left, anti-join, self-join, m2m bridge with fan-out trap, join-vs-EXISTS, aggregation-after-join). Every drill: ≥2 cases distinct by data, the named wrong-join cheese must fail at least one case, sql content rules binding, reference-grade 1.00.

- [ ] **Step 1: Write the 8 manifest rows** (id/kind/tier/axis/trap-vector cells).
- [ ] **Step 2: Author the drills; pack integrity green** (`ATROPHY_BANK=<pack>`).
- [ ] **Step 3: Reference-grade each 1.00 + record; verify each named cheese scores < 1.00.**
- [ ] **Step 4: Merged doctor 0/0; commit (by name)** `feat(pack): sql joins set (8)`.

### Task 6: Recall backlog triage (all 147 rows)

**Files:**
- Modify: `atrophy-pack/DRILL-MANIFEST.md` only

**Requirements:** spec C4-triage. Every recall-candidate row gets a ruling cell: `viable` or `unusable(<reason>)`, reasons from {describes-a-table, ambiguous-answer, duplicate-of-<id>, not-a-fact}. Already-authored recall rows are marked `shipped(<id>)`. The task report states the viable count and lists viable ids in manifest order — Tasks 7-8 consume that list verbatim.

- [ ] **Step 1: Rule every row; commit (manifest only)** `docs(pack): recall backlog triage — every row ruled`.

### Task 7: Author viable recalls, wave A (first half)

**Files:**
- Create: pack recall JSONs for the FIRST HALF of Task 6's viable list (manifest order)
- Modify: `atrophy-pack/DRILL-MANIFEST.md` (mark authored rows `shipped(<id>)`)

**Requirements:** spec C4-author: id = row slug; concrete language tag iff the fact presupposes one (Plan C retag criterion); numeric tolerance shapes; teaching `reveal` where it helps; reference-grade 1.00 each with record. Pack integrity + merged doctor per gates.

- [ ] **Step 1: Author wave A; integrity green; reference grades recorded.**
- [ ] **Step 2: Commit (by name)** `feat(pack): recall corpus wave A (<n>)`.

### Task 8: Author viable recalls, wave B (second half)

Same files/requirements/steps as Task 7 for the SECOND HALF of the viable list.

- [ ] **Step 1: Author wave B; integrity green; reference grades recorded.**
- [ ] **Step 2: Commit (by name)** `feat(pack): recall corpus wave B (<n>)`.

### Task 9: Wording pass + b02

**Files:**
- Modify: every sql drill prompt (pack + base statics) carrying the "exactly one SELECT" line; `atrophy-pack/exercises/b02-algorithm-complexities.json`

**Requirements:** spec C5. One canonical sentence making `WITH … SELECT` unambiguously allowed (a CTE chain is one statement), applied uniformly; b02's `offer()` genericized without changing the graded surface. Prompts only — no test/case/answer changes; every touched drill's reference grade re-run (1.00, unchanged).

- [ ] **Step 1: Inventory prompts carrying the line (grep both repos); apply the canonical sentence.**
- [ ] **Step 2: b02 edit; re-grade touched drills; integrity green both repos' gates.**
- [ ] **Step 3: Commits** — atrophy `docs(bank): sql prompt wording — CTEs are one statement`; pack (by name) `docs(pack): sql wording pass + b02 genericized`.

### Task 10: Wrap — docs sync + full gates

**Files:**
- Modify: `README.md`, `CLAUDE.md` (only where Plan D changed what's true: mix policy behavior, recall in base bank, drift guard, pack counts)

**Requirements:** every claim measured before written (Plan C's F1-F5 lesson); the Task 4 drift guard must pass against the final README. Full gates: typecheck, `npm test` zero-skip, pack integrity, merged doctor, dashboard payload untouched (`buildPayload` unchanged this plan — verify by diff).

- [ ] **Step 1: Update docs from measured behavior; run every gate; commit** `docs: plan D closeout — mix policy, base recalls, drift guard`.

---

After Task 10: final Fable whole-branch review — atrophy range `d98f5ac..HEAD` (everything after Plan C's last commit, spec/plan docs included), pack range `ac437cb..HEAD` — ONE fix wave max, scoped re-review, then push atrophy AND pack (user-sanctioned: "Start and complete Plan D").
