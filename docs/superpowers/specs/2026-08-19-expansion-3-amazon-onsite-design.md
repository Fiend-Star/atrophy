# Expansion-3: the Amazon onsite corpus (onsitesApril2025) — design

**Date:** 2026-08-19
**Status:** approved by user order (program green-light "2, 3, 4, then 1"; /usage confirmed weekly headroom at Expansion-2 close)
**Repos:** content in Java-OAs (**new pack** `atrophy-pack-amazon/`), docs in atrophy (branch `feat/java-language-support`)
**Source of truth:** `src/main/java/companies/amazon/onsitesApril2025/` — four round files + `LLD_Excel/` (12-class reference implementation, 941 lines) + `HLD/` (system_design.md, Practice/log_management_system.md).

## Goal

Mine the Amazon April-2025 onsite loop into graded drills: the LLD Excel round (the meat), the HLD round as outlines, and whatever Round 1's p70 question still yields after Aurora already shipped `aur-p70-*` from it. Expected size **~15–25 drills** — one authoring wave, the smallest effort of the program.

## Non-goals

- No behavioral content, ever: Rounds 1/3's behavioral notes contain the user's personal stories and employer project codenames (finra, RAMS, ICCR, ETR-dash, Email2Db, JWT/hackathon stories). **Zero of that text may reach any tracked pack file — prompts, reveals, rubric bullets, manifest cells, reports.** The Expansion-1 privacy law (class-only descriptions) binds; here the rule is simpler: behavioral content yields no drills at all.
- No engine changes; no Lombok in anything graded (the grading JVM has no Lombok jar — the LLD reference's `@Getter`-style sketches must be respecced to plain Java, compile-clean).
- No re-authoring of Aurora's p70 coverage.

## Deliverables

### D1 — Pack scaffold + triage roster (Task 1, opus)

New pack `Java-OAs/atrophy-pack-amazon/`: `pack.json` `{"name": "amazon"}` (track name per Expansion-0 semantics), `MANIFEST-AMAZON.md` with a roster table (slug/axis/kind/grading/tier/soft-min/source/notes per row — DE Shaw manifest conventions), exercises dir. T1 enumerates every gradable unit and rules:

- **p70 dedup (D-p70):** read the four `aur-p70-*` drills' content and differentiation notes; rule whether a graded op-driver `write` over the full class contract (add/getAll/getP70 with **injected timestamps** — no wall clock, per determinism law) is complementary or a leak; if complementary, its prompt may not restate what aur-p70 grades (the interpolation formula is aurora's turf — n≡1/6 mod 10 exactness precedent travels if any double is graded).
- **LLD Excel decomposition (D-lld):** enumerate gradable units from the requirements text + reference implementation. Candidate units (T1 refines): CellAddress A1-notation round-trip (write/json-tests); FormulaEvaluator over literal+reference formulas (write or write-harness; pin the formula grammar from the reference — 176 lines); Worksheet insert-rows/columns address shifting (write-harness candidate); cell-type dispatch + factory (write or cloze); observer/recalculation propagation (write-harness); plus outline row(s) for the LLD decomposition itself and recall rows only if the docs carry the answer. Every graded signature compile-clean pure Java; in-place `void` respec-to-return where needed.
- **HLD outlines (D-hld):** temperature-sensor design and log-management practice doc → `outline` rubric rows; bullets sourced from the docs' own content (per the Expansion-2 ruling-9 discipline: bullets must be checkable against a cited passage; these docs are the user's own notes — quote their substance, never their personal anecdotes).
- **Axis/tier map:** decomposition dominant; syntax-recall where the unit is API-shaped; tiers per DE Shaw conventions.

### D2 — One authoring wave (Task 2, opus)

Author every roster row per its cells; the full Expansion-2 traveling law binds verbatim: Java authoring rules (CLAUDE.md), claim-verification gate (violator per prompt claim, sub-1.00, tabled), no-epsilon exactness by construction, determinism (injected clocks, canonical orders, join-with-timeout if any concurrency appears), leak discipline (against aur-p70, the DE Shaw pack's 369, and within-pack), output-cap conventions (maximal-output probe for collection-returning rows near stated ceilings; complexity claims ride answer magnitude or state unenforced), stamping (`shipped expansion-3 (<commit>)` in the roster).

### D3 — Consistency + build status (Task 3, sonnet) and Fable final → push

Build-status section, roster↔file bijection script, full gates, a few random re-grades; Fable whole-branch final (394eb5e-era rules: privacy sweep is the headline check here); push Java-OAs master; atrophy docs (this spec + plan) push with the branch.

## Gates (scratch env always: ATROPHY_DB scratch + ATROPHY_NO_SYNC=1)

- Pack-only: `ATROPHY_BANK=<atrophy-pack-amazon> npx vitest run bank/bank-integrity.test.ts` green.
- Merged doctor: `ATROPHY_PACKS="<atrophy-pack>;<atrophy-pack-aurora>;<atrophy-pack-amazon>"` → zero collisions, expected = 622 + roster count; track table shows `amazon`.
- Every reference 1.00 through the real CLI; every violator sub-1.00; outlines gated by bank-integrity + per-bullet source check (no `--solution` surface).

## Estimated size and effort

~15–25 drills, 1 wave, ~0.3–0.5 Expansion-0 units. Process: SDD as before — T1 (opus) → T2 (opus impl + opus execution-verified review) → T3 (sonnet + sonnet review) → Fable final → push. Serial; no worktrees needed (single implementer at a time, new pack dir = no contention).
