# Expansion-3: Amazon Onsite Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mine `companies/amazon/onsitesApril2025/` into a new ~15–25-drill `atrophy-pack-amazon` (track `amazon`), gated by real compile-and-run integrity and execution-verified review.

**Architecture:** New pack scaffold + triage roster (T1) fixes the enumeration and the three D-rulings; one authoring wave (T2) writes every roster row; consistency (T3) closes the books; Fable final gates the push. Serial, main checkout, no worktrees.

**Tech Stack:** atrophy engine (JDK 21 grading, bank-integrity gates), Java-OAs content, `npx tsx` CLI grading.

**Spec:** `docs/superpowers/specs/2026-08-19-expansion-3-amazon-onsite-design.md` — its Non-goals (privacy: zero behavioral content, no personal project codenames anywhere) and D1 rulings travel into every task verbatim.

## Global Constraints

- PRIVACY (hard law): no behavioral-note text, no personal project codenames (the codename list lives in the E3 spec §Non-goals and ONLY there — this plan deliberately does not echo it; sweeps reference codenames by index), no personal stories in ANY tracked file. Behavioral rounds yield zero drills.
- Expansion-2 traveling law binds verbatim: Java authoring rules, claim gate (violator per claim, sub-1.00, tabled), no-epsilon exactness, determinism (injected clocks — never wall clock), leak discipline (vs aur-p70 + DE Shaw 369 + within-pack), output-cap conventions, roster stamping `shipped expansion-3 (<commit>)`.
- No Lombok in graded content; every starter compiles.
- Scratch env for ALL grading (ATROPHY_DB scratch, ATROPHY_NO_SYNC=1); never the real ~/.atrophy.
- Java-OAs commits stage ONLY `atrophy-pack-amazon/` paths BY NAME; trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Windows: `npx tsx cli/index.ts …`, never `npm run dev --`.

---

### Task 1: Pack scaffold + triage roster + D-rulings

**Files (Java-OAs):** Create `atrophy-pack-amazon/pack.json` (`{"name": "amazon"}`), `atrophy-pack-amazon/MANIFEST-AMAZON.md` (roster table: slug/axis/kind/grading/tier/soft-min/source/notes).

- [ ] **Step 1:** Read the whole corpus (`onsitesApril2025/` incl. LLD_Excel/*.java and HLD/*.md) and the four `aur-p70-*` drills in `atrophy-pack-aurora/`.
- [ ] **Step 2:** Rule D-p70 (complementary injected-timestamp op-driver vs skip), D-lld (final gradable-unit list with kind/tier per unit), D-hld (outline rows + rubric sourcing) — each ruling recorded in its roster row's notes cell.
- [ ] **Step 3:** Write the roster; state the final drill count; verify zero slug collisions vs both existing packs (grep ids).
- [ ] **Step 4:** Commit: `feat(pack): atrophy-pack-amazon scaffold + expansion-3 roster`.

### Task 2: The authoring wave

**Files (Java-OAs):** `atrophy-pack-amazon/exercises/<axis>/<slug>.json` per roster row + roster stamps.

- [ ] **Step 1:** Author every roster row per its cells + rulings; reference per drill; violator per prompt claim; exactness argument for any double; injected-clock determinism for anything timed.
- [ ] **Step 2:** Gates: pack-only bank-integrity green; merged doctor (base + all three packs) zero collisions at 622 + count, track table shows `amazon`; every reference 1.00 via CLI; every violator sub-1.00 (table in report); outlines per-bullet source check.
- [ ] **Step 3:** Stamp roster rows `shipped expansion-3 (<content-commit>)`; commits: content then stamps, Aurora convention.

### Task 3: Consistency + build status

- [ ] **Step 1:** MANIFEST-AMAZON build-status section (commit chain, counts, gates); roster↔file bijection + stamp script checks; 3 random re-grades.
- [ ] **Step 2:** Commit: `docs(pack): expansion-3 build status + consistency`.

### Final: Fable whole-branch review → push

Whole-pack review (BASE = Java-OAs master at effort start): privacy sweep is the headline check (behavioral text + codenames grep across every added file), plus cross-pack leak sweep (aur-p70 hardest) and sampled re-grades. One fix dispatch if needed → push master → atrophy docs push → PR body touch only if pack facts cited there change.
