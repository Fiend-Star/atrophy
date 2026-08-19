# Expansion-2: §3.10 DSA Backlog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Author every unshipped §3.10 DSA row (~97–108 graded-Java drills + 3 outlines) into the DE Shaw pack (`Java-OAs/atrophy-pack/`), gated by real compile-and-run integrity and execution-verified reviews.

**Architecture:** The manifest rows are the per-drill requirements; Task 1 fixes the enumeration and closes the open design decisions; six serial topic-cluster waves author against the rows; a consistency pass closes the books. No engine changes; no new pack.

**Tech Stack:** atrophy engine (JDK 21 grading, bank-integrity gates), Java-OAs `atrophy-pack` content, better-sqlite3 CLI grading via `npx tsx`.

**Spec:** `docs/superpowers/specs/2026-08-19-expansion-2-dsa-backlog-design.md` — its Binding rules section travels into every task verbatim.

## Global Constraints

- Rows bind: slug/axis/kind/grading/tier/soft-min/notes from DRILL-MANIFEST.md §3.10 are the contract; deviations need a recorded ruling.
- Java authoring rules (atrophy CLAUDE.md) + claim-verification gate + no-epsilon exactness + determinism/order-spec rules + op-driver convention + stamping convention: spec Binding rules 1–8, verbatim.
- Scratch env for ALL grading (`ATROPHY_DB` scratch, `ATROPHY_NO_SYNC=1`); never the real `~/.atrophy`.
- Java-OAs commits stage ONLY `atrophy-pack/` paths BY NAME; never `git add -A`. Commit trailers: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Windows: `npx tsx cli/index.ts …` directly, never `npm run dev --`.

---

### Task 1: Enumeration + design decisions (§3.10a)

**Files (Java-OAs):** `atrophy-pack/DRILL-MANIFEST.md` — new §3.10a build-plan section + in-place notes-cell rulings on the NEEDS-AUTHORING rows.

- [ ] **Step 1:** Enumerate every §3.10 row; classify shipped (plan-C-stamped) vs unshipped; reconcile the 146-headline / 135-table-sum / 38-shipped arithmetic and state the final unshipped count.
- [ ] **Step 2:** Assign each unshipped row to wave W1–W6 per the spec's D2 clusters; record the table in §3.10a.
- [ ] **Step 3:** Rule each spec-D1 design decision (min-stack-kth-min contract; partition-array variant; clone-graph + convex-hull harness designs; max-path-sum movement rules; task-scheduling statement; SCS grading mode; median-two-sorted exactness argument; outline-rows rubric sourcing) — each recorded in the row's notes cell.
- [ ] **Step 4:** Commit: `docs(pack): §3.10a expansion-2 build plan + authoring rulings`.

### Tasks 2–7: Authoring waves W1–W6 (serial)

Each wave: **Files (Java-OAs):** `atrophy-pack/exercises/<axis>/<slug>.json` per assigned row + manifest stamps.

- [ ] **Step 1:** Author every assigned row per its cells + notes + §3.10a rulings; reference solution per drill; violator per prompt claim (claim gate); exactness argument for any double.
- [ ] **Step 2:** Gates: pack-only bank-integrity green; merged doctor (base + both packs) zero collisions at the expected count; every reference 1.00 via CLI; every violator sub-1.00 with the table in the report.
- [ ] **Step 3:** Stamp rows `shipped expansion-2 wave <N> (this commit)`; commit `feat(pack): expansion-2 wave <N> - <cluster> (<count> drills)`.

Wave clusters (final rows per T1's table): W1 arrays/sliding-window/two-pointers · W2 binary-search/stack/linked-list · W3 DP/heaps/backtracking · W4 graphs/UF-BIT/tries · W5 trees/concurrency (harness-heavy) · W6 master-index/self-tests (incl. 3 outlines).

### Task 8: Consistency pass + build status

- [ ] **Step 1:** §3.10a completion table (per-wave commits, reconciliation); build-status row; carry-list items accumulated by reviews; scripted checks (new-row↔file bijection, stamp integrity, totals).
- [ ] **Step 2:** Full merged gate + 5 random re-grades.
- [ ] **Step 3:** Commit: `docs(pack): expansion-2 build status + wording sweep`.

### Final: Fable whole-branch review → push

Whole-branch review over the pack diff (BASE = Java-OAs HEAD at effort start); one fix dispatch if needed; push master; update atrophy PRs only if atrophy docs changed (this plan + spec land on `feat/java-language-support`).
