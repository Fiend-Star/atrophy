# Plan D — Closeout: mix policy, importability, drift guard, recall corpus, SQL joins

**Status:** approved (user scope answers 2026-08-15). **This is the final plan** for the java/sql support effort; everything here either ships or is closed with a ledgered ruling.

## Goal

Close the consolidated backlog left by Plans A-C: three engine items (language mix soft-cap, CLI importability, README drift guard), the base bank's recall gap, the deferred SQL joins curriculum, and the pack's recall-candidate backlog (triage all 147 manifest rows, author every viable one).

## User scope decisions (binding)

1. SQL joins set: **author ~8 pack drills**.
2. Base recalls: **small set, 6-8 drills**, tagged or `"any"` as content dictates.
3. Recall backlog: **triage all 147 manifest recall-candidate rows AND author every viable row** (~50-70 expected; the triage's count is authoritative).
4. Cross-language mix policy: **implement** (soft cap, engine + CLI wiring + tests).
5. All Plan D subagent seats run on **Fable** (user order: "use pure fable, only, as its the last plan").

## Engine work

### E1 — Language mix soft-cap (select.ts + CLI wiring)

Problem: with no `--lang` flag, nothing stops one concrete language from dominating a stretch of draws (the pack skews java-heavy).

Design:
- `SelectOptions` gains `recentLanguages?: (Language | "any")[]` — the languages of the caller's most recent recorded sessions, most-recent-first. Optional; absent = no policy (all existing call sites and tests unchanged).
- Policy applies **only when `language === undefined`** (an explicit `--lang` is the user steering; never fight it).
- Rule: let `window` = first 6 entries of `recentLanguages`. If a concrete language `L` appears ≥ 3 times in `window`, candidates with `language === L` get selection weight ×0.25. `"any"` candidates are never penalized. This is a *soft* cap: a tier pool containing only `L` candidates still serves `L` (weights renormalize; never filter to empty).
- Implementation point: the within-pool weighted pick in `selectExercise` (generator 2× weighting already exists there — the language multiplier composes with it).
- CLI: `drillOnce` reads the last 6 sessions' exercise languages from the store (new small store helper `recentSessionLanguages(db, n)` in `store/db.ts`, ordered by recency) and passes them. `baseline` does not (it already forces per-axis coverage and typically a `--lang`).
- Tests (engine, injected rng + fake toolchains): dominance triggers the penalty (measurable via draw distribution with a seeded rng); explicit `language` bypasses; all-`L` pool still serves `L`; `"any"` unpenalized; absent `recentLanguages` = today's behavior bit-for-bit.

### E2 — CLI importability (cli/index.ts)

Problem: importing `cli/index.ts` executes commander parsing — its internals (e.g. `drillOnce`, arg wiring) are untestable without spawning a process.

Design:
- Move command registration + `program.parse` behind an entry guard: run only when the module is the process entry. ESM/Windows-safe check: compare `import.meta.url` against `pathToFileURL(process.argv[1]).href` (guard `process.argv[1]` undefined; a `.js`-vs-no-extension mismatch must be handled the way tsx and node both satisfy — resolve via `realpathSync` before `pathToFileURL`).
- Export the seams tests need: `drillOnce` and the command action functions. No behavior change to any command.
- Test: a vitest file imports `cli/index.ts` and asserts (a) import causes no parse/exit/stdout side effect, (b) exported functions exist. Both source (`tsx`) and built (`dist/`) paths must keep working — CI's build step plus the existing dual-path asset resolution cover the built form.

### E3 — Five-skills-table drift guard (new test)

Problem: README's five-skills table drifted from measured selection behavior twice in Plan C (F1, F4).

Design: a colocated test (`cli/readme-claims.test.ts` or similar) that computes, from the *built-in* bank + generator registry, the per-axis facts the README table claims (offerable kinds per axis, the `--lang` row's language rule) and compares them to a literal fixture in the test file. The fixture carries a comment: "this mirrors README's five-skills table — update BOTH together." Drift in either direction fails the test with a message naming the README section. No README parsing (brittle); the fixture is the contract.

## Content work — base bank (atrophy repo)

### C1 — Base recalls (6-8)

6-8 recall exercises under `bank/exercises/<axis>/`, ids per axis prefix scheme. Content: durable, universal engineering facts (complexity of canonical operations, language gotchas worth cold recall). Each is tagged a concrete `language` when the fact presupposes one, else `"any"` — the Plan C retag criterion. Numeric answers use the tolerance shapes (`1/4` ≡ `0.25` ≡ `25%`). `reveal` where a one-line elaboration teaches; reveal is never graded. Every drill reference-graded 1.00 through the real CLI.

### C2 — sr-sql-001 COUNT DISTINCT case (N1 carry)

Add the discriminating case ruled in Plan C's N1 carry: a fixture where `COUNT(col)` and `COUNT(DISTINCT col)` differ, so the non-DISTINCT impostor fails. Existing cases stay byte-identical (replay). Integrity + reference grade re-run.

## Content work — pack (Java-OAs repo)

### C3 — SQL joins set (~8 drills)

New sql `write` drills under `atrophy-pack/exercises/`, manifest rows first (kind/tier/axis/grading per row — the row is the requirement, Plan C convention). Coverage: inner vs left semantics, anti-join (LEFT+IS NULL vs NOT EXISTS), self-join, many-to-many bridge with fan-out trap (a case where naive join double-counts), join-vs-EXISTS equivalence, aggregation-after-join. Every drill obeys the Plan C sql content rules (below); every drill needs a case where the classic wrong-join cheese (INNER where LEFT needed, unde-duplicated fan-out) fails.

### C4 — Recall backlog: triage ALL, author ALL viable

- **Triage:** every one of the 147 recall-candidate manifest rows gets a ruling cell: `viable` or `unusable(<reason>)` (reason: describes-a-table, ambiguous-answer, duplicate-of-<id>, not-a-fact). The ledgered caveat says ~half describe tables; the triage count is authoritative.
- **Author:** every `viable` row becomes a pack recall drill (id = slug), language-tagged per the retag criterion, tolerance shapes for numeric answers, reveal where it teaches. Waves split the viable list in manifest order; every drill reference-graded 1.00.

### C5 — Wording pass + b02

- Pack-wide: reconcile sql prompts' "exactly one SELECT" phrasing with CTE reality — a `WITH … SELECT` is one statement and must read as allowed. One canonical sentence, applied to every sql drill prompt that carries the old line (base statics included if they carry it).
- `b02-algorithm-complexities`: genericize the `offer()` token (reviewer's optional note) without changing the graded surface.

## Binding content rules (inherited, still in force)

Plan B ledger: N−1 harness conventions, deadline-race ≥2×, no default-satisfiable checks, verbatim catch-all + `Atrophy.report()` in finally, 0/N-by-running starters. Plan C ledger: sql cases distinct by DATA; no clock/random in fixtures; expectedRows scalars are string|number|null (no booleans); REAL 2.0 ≡ INTEGER 2 in canon; ±2^53; ROUND quantization; timeout traps sized by op count with ≥100× margin; recall numeric tolerance; every authored drill reference-graded 1.00 through the real CLI with command + score recorded.

## Gates & invariants

Per task: typecheck, `npm test` (zero java SKIPPED), pack integrity (`ATROPHY_BANK=<pack>`), merged doctor (0 collisions/0 warnings) when pack content changes, reference grades recorded. Product invariants untouched: ai-on never moves unaided rating; harnessError never evidence; RD widens, rating never decays; generator determinism (no generator family output changes in this plan). All CLI runs that could record: `ATROPHY_NO_SYNC=1` + throwaway `ATROPHY_DB`. Pack commits stage `atrophy-pack/` paths by name only.

## Process

SDD (fresh implementer per task + task review + scoped re-reviews), **all seats Fable**. Final Fable whole-branch review over both repos, one fix wave max, then push atrophy (PRs #1/#38) and push the pack. Closed-without-build items get ledger rulings: scan-weighted scoring stays a design note (no chooser); this spec's ledger is the last — any post-Plan-D idea goes to the repo issue tracker, not a Plan E.
