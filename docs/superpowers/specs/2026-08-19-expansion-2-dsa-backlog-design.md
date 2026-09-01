# Expansion-2: the §3.10 DSA backlog — design

**Date:** 2026-08-19
**Status:** approved by user order ("All viable (~108)"; "Go ahead lets go and complete next")
**Repos:** content in Java-OAs (`atrophy-pack/` — the existing DE Shaw pack, NOT a new pack), docs in atrophy (branch `feat/java-language-support`)
**Source of truth:** `atrophy-pack/DRILL-MANIFEST.md` §3.10 ("DSA — doc 03 planned problems"), lines ~326–544 — the rows ARE the triage; each carries slug, axis, kind, grading, tier, soft-min, source, and binding authoring notes.

## Goal

Author **every §3.10 row not already marked shipped** — the survey estimated ~108; a first hand count of the group tables says ~97 unshipped of a 135-row table sum against a 146-row section headline. Task 1 reconciles these numbers exactly and its enumeration is final. All are graded-Java drills for the DE Shaw pack (`decomposition` dominant, a few `syntax-recall`), plus three `outline` self-test rows.

## Non-goals

- No §3.11 (design/LLD/OS), no §4.x derived items, no wave-X blocked rows — §3.10 only.
- No engine changes. The engine has NO epsilon and gets none; exactness is discharged by case design (the `find-median-data-stream` / `champagne-tower` / Aurora-p70 precedents).
- No new pack: these rows belong to `atrophy-pack` and its manifest; ids must stay unique across base + atrophy-pack + atrophy-pack-aurora (525 currently loaded).
- No re-authoring of the 38 shipped rows; no touching their notes except where a NEEDS-AUTHORING decision explicitly amends a row.

## Deliverables

### D1 — Enumeration + design decisions (Task 1, the keystone)

A new manifest section (`§3.10a Expansion-2 build plan`) recording: (a) the exact unshipped-row enumeration with the 146/135/38 arithmetic reconciled; (b) wave assignment per row (see D2); (c) a RULING for each open NEEDS-AUTHORING decision, each recorded in the row's notes cell in place:
- `min-stack-kth-min` — O(1) `getKthMin` is not achievable for arbitrary k; bound k (aux sorted window) or relax to O(log n). Pick, and pin the contract.
- `partition-array-min-difference` — LC 2035 equal-halves vs the doc's unrestricted-subset variant. Pick one, state it precisely.
- `clone-graph`, `convex-hull` — harness designs (isomorphism + no-shared-identity; cyclic-sequence normalization + collinear policy).
- `max-path-sum-matrix` — movement rules pinned.
- `task-scheduling-min-time-servers` — full problem statement authored (pattern is given, statement is not).
- `shortest-common-supersequence` — grade length only vs validator. Pick.
- `median-two-sorted-arrays` — the row's "needs epsilon" note is resolvable without one: integer inputs make every median a whole or exact-half value, exactly representable; record the exactness argument and the case-design obligation.
- The three `outline` self-test rows — confirm rubric-bullet sourcing from their docs' own answer keys (the docs ship answers; bullets quote them).

### D2 — Six authoring waves (Tasks 2–7), serial, by topic cluster

- **W1** Arrays & hashing + Sliding window + Two pointers (~19)
- **W2** Binary search + Stack/monotonic + Linked list (~17)
- **W3** Dynamic programming + Heaps remainder + Backtracking (~16)
- **W4** Graphs + Union-Find/BIT + Tries (~15)
- **W5** Trees + Concurrency round (~12; harness-heavy — most `write-harness` rows live here)
- **W6** Master-index-only + R04/self-test bundles (~18, incl. the 3 outlines)

Waves are serial (manifest contention — the Aurora pre-flight ruling stands). Each wave: every unshipped row in its groups; row cells (kind/axis/tier/soft-min) bind; notes bind (order-specs, respec-to-return rules for in-place `void` signatures, overflow cases, validator requirements).

### D3 — Consistency pass + build status (Task 8)

DRILL-MANIFEST build-status row + §3.10a completion table (per-wave commits, reconciliation arithmetic); wording sweep; scripted checks (row↔file bijection for the new drills, stamp integrity, §3.10a totals).

## Binding rules (traveling law, from the shipped ledgers)

1. **Java authoring rules** (atrophy CLAUDE.md): compile-clean starters, `public class Solution` no package line, package-private-or-public graded methods, no overloads by arity, `Map<String,…>` literal keys, tests within ±2^53, fix bugs semantic (N/A here — no fix rows in §3.10), harness kinds use `Atrophy.plan/check/report` + watchdog + always-report.
2. **Claim-verification gate** (Aurora §9, wave E/F): a prompt may not claim the tests enforce what they cannot — for each claim, write the violating solution, grade it, confirm it fails; add a binding case or reword; never scale-until-timeout. Complexity constraints the tests cannot enforce are stated in the prompt AS unenforced (several rows' notes already say so — `first-missing-positive`, `trapping-rain-water`, `josephus-problem`, `sliding-window-maximum`).
3. **No-epsilon exactness**: any `double`-returning drill ships values exact by construction, with the representability argument in the report (and the manifest note where the row flagged it).
4. **Determinism**: every multiple-valid-answer row either specs a canonical order (the note usually already does) or is `write-harness` with a validator; no wall-clock, no unseeded randomness in graded output; concurrency harnesses join with timeout so a deadlock fails the drill rather than hanging (watchdog well under testTimeoutMs).
5. **Op-driver convention**: op-sequence rows (`time-based-key-value-store`, `implement-trie`, `range-sum-query-mutable`, `min-stack-kth-min`) follow the shipped op-driver shape in the pack (e.g. `design-leaderboard`, `find-median-data-stream`).
6. **Leak/dup discipline**: ids unique across all three banks (merged doctor gate); prompts must not hand a sibling drill its answer; the Aurora pack's aur-quickselect/aur-p70 rows exist — W2/W3 prompts must not collide with their differentiation notes (both packs load together).
7. **Stamping**: shipped rows gain `shipped expansion-2 wave <N> (<commit>)` in their wave cell, same convention as the plan-C stamps; ruling-cell changes move in the same commit as the change they describe.
8. **Gates per wave** (scratch env always — ATROPHY_DB scratch + ATROPHY_NO_SYNC=1): pack-only `ATROPHY_BANK=<atrophy-pack> npx vitest run bank/bank-integrity.test.ts` green (compiles every starter — the pack is large, budget the runtime); merged doctor over base + both packs → zero collisions, expected count; every reference 1.00 through the real CLI; violator table per the claim gate.

## Estimated size and effort

~97–108 drills across 6 waves + triage + consistency. Expect the largest effort of the program (~1.5–2 Expansion-0 units). Waves launch serially per the adaptive protocol; ccusage (×1.6) check before each wave dispatch; ≤15% weekly per wave.

## Process

SDD as Expansion-1: T1 triage/decisions (opus) → T2–T7 waves (opus implementers, opus reviewers, execution-verified reviews with cheese attempts and full answer-key/expected-value re-derivation) → T8 consistency (sonnet) → Fable whole-branch final review → push Java-OAs master + update atrophy PRs if docs land.
