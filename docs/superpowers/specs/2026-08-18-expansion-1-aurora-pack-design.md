# Expansion-1: the Aurora pack — design

**Date:** 2026-08-18
**Status:** draft, awaiting user review
**Repos:** content in Java-OAs (new pack dir), one small engine task in atrophy (branch off `feat/java-language-support` @ e1d36b4)
**Sources:** `Java-OAs/src/main/java/companies/amazon/auroraControlPlane2026/` — the 2026-08-18 survey found ~90–115 viable drills concentrated in three of sixteen files; this spec is that survey's scope, made binding.

## Goal

A new exercise pack, **`atrophy-pack-aurora/`** in the Java-OAs repo, selectable as `--track aurora`, containing the viable AWS control-plane / Aurora-internals content: recall cards on durable doctrine, outlines with source-anchored rubrics, and a small graded-Java set. Plus one engine task in atrophy closing the final review's setup-polish minors.

## Non-goals

- No behavioral/LP/logistics content — 11 of the 16 corpus files are out of scope by name: `00_README`, `CLAUDE.md`, `01_Loop_Intelligence`, `02_Leadership_Principles`, `06_Prep_Schedule`, `07_Phone_Screen` (except its ~2 net-new recalls if the triage rates them), `08_STATE`, `sources/README`, `sources/02`, `sources/03`, and `sources/04` outside its launch-facts section.
- No mining of `onsitesApril2025/` (that is Expansion-3).
- No engine changes beyond the setup-polish task. No schema changes at all.

## Deliverables

### D1 — Pack scaffold (Java-OAs)

`atrophy-pack-aurora/` as a **sibling** of `atrophy-pack/` — per the Expansion-0 rule, a pack is NEVER nested under a bank dir or another pack (nesting attributes files to the outer root and the track serves 0). Contents: `pack.json` `{"name": "aurora", "description": "AWS control-plane & Aurora internals (2026 corpus)"}`, exercise JSONs under `exercises/<axis>/`, and `MANIFEST-AURORA.md`. Pack dir basenames must never be `all` or `base` (reserved track words).

### D2 — MANIFEST-AURORA.md + triage roster (the Plan-D §4.24 pattern)

Before any authoring: enumerate every candidate from the in-scope files into a roster table — slug, source (file §), intended kind/axis/language/tier, stability class, constraint clauses — and RULE each row viable/unusable. The binding content conventions travel verbatim from DRILL-MANIFEST.md §4.24 and the Plan B/C/D ledgers: **the accepted set mirrors the prompt's framing**; tag-from-fact; verify arithmetic independently (this corpus's own author warns figures drift — and the HRT survey caught 5/10 wrong stated answers in a sibling corpus, so every numeric is re-derived, never lifted).

**Stability split (binding, from the survey):** SIGMOD-2017-anchored Aurora facts ship as durable recalls (6 copies / 3 AZs / 2-per-AZ, 4-of-6 write + 3-of-6 read quorum, 10 GB segments, log-is-the-database, redo-only shipping). The moving feature-table specs (replica counts, ACUs, I/O-Optimized, Global Database lag, 256 TiB) ship only with a date-stamp constraint clause in the prompt, or are ruled unusable. Named exclusions: the "5x MySQL / 3x PostgreSQL" figure (source contradicts itself with 6x); comp/CSEP numbers; pipeline dates.

### D3 — Recall wave (~38–50 shipped, est.)

From `05` §1.2 + §3–§4 (Aurora storage + operational canon: static stability, client request tokens, reconciliation, cell-based architecture, shuffle sharding, constant work, jitter, load shedding, fencing tokens), `04` §2.1–§2.2 (sensor arithmetic: 100k writes/s, 8.64B/day, ~200 GB/day, 1:1000 read:write; distributive vs algebraic aggregates), `sources/01` §6 (ZDP, Well-Architected REL11-BP04/REL04-BP04, one-AZ-at-a-time zonal calendar, the Weiss/Furr control-plane definition), `sources/04` launch facts (DSQL GA 2025-05-27 + multi-Region 99.999% + Rust; Limitless GA 2024-10-31). Language tag: `"any"` for doctrine (these are not Java facts); axis per roster ruling (api-memory expected dominant). Every accepted set enumerates all offered forms per the convention.

### D4 — Outline wave (~18–24 shipped, est.)

`05` §5's sixteen questions + `04` §4's seven-point control-plane template — the rubric bullets come from §1–§4 of the same file, so each outline's rubric is source-anchored, not invented. Axis decomposition, language `"any"` (schema pins outline there).

### D5 — Graded-Java mini-set (~8–11 shipped, est.)

- **p70 family** (`03` §2): a `write` drill for the windowed p70 tracker (`add`/`getAll`/`getP70`, 60s window) authored around the *windowed + memory-bounded* angle (overlap guard: `find-median-data-stream` is shipped in the DE Shaw pack — the roster must record the differentiation); a ring-buffer/quickselect variant; 3–4 `fix` drills planted from §2.3's six named defects (each bug must be semantic and actually fail a test — bank-integrity enforces).
- **Control-plane primitives as `write`/`write-harness`**: fencing-token guard (reject below high-water mark), idempotency store keyed on client request token (overlap guard: differentiate from shipped `execid-dedup` or fold — roster rules it), reconciliation diff (desired vs observed → minimal action list), shuffle-shard assignment with overlap assertion.
- The `03` numeric post-mortem facts (13.9 adds/s, n≈833 resident, ~8,100 comparisons/query) ride in D3 as recalls, re-derived.
- Java authoring rules from CLAUDE.md bind (compile-clean starters, unnamed package, harness always reports, totalChecks exact).

### D6 — Cloze (~3–5, roster-ruled)

`05` reconciliation pseudocode and the `CreateDBCluster` step tree — cloze needs a concrete language tag (no `"any"` in the schema): tag `java` where the snippet is Java-shaped, else demote to recall. Roster decides per row.

### D7 — Setup polish (atrophy repo, one task)

Closes final-review M2–M4: interactive setup rejects an out-of-range numeric pick (re-prompt, never silently write "all"); interactive setup refuses to persist an ambiguous track name (prints the ambiguity, re-prompts); `--show` combined with setter flags prints one "ignoring --languages/--track (--show never writes)" line. Tests for each. Small branch off `feat/java-language-support`, merged on green per the Expansion-0 flow.

## Verification & gates (binding)

- **Answer-key verification rate: 100%** — every recall's accepted set and every reveal is re-derived (arithmetic recomputed, dates cross-checked against the corpus's own citations); reviewers verify independently, Plan-D style.
- **Content gate:** `ATROPHY_BANK=<pack> npx vitest run bank/bank-integrity.test.ts` green; `atrophy doctor` with base + DE Shaw pack + aurora pack merged shows zero id collisions and the track table lists `aurora` with the expected count; a reference solution per graded drill scores 1.00 through the real CLI (`ATROPHY_DB` scratch + `ATROPHY_NO_SYNC=1`).
- **Overlap gate:** the roster carries a dup-risk column; the survey's named collisions (p70/find-median, idempotency/execid-dedup, LLD pattern dressings, HashMap internals, the CME "Aurora" false positive, td-recon-breaks false positive) must each have an explicit ruling.
- **Id scheme:** slugs prefixed `aur-` (e.g. `aur-quorum-write`, `aur-p70-window-write`); ids unique across base + both packs.

## Estimated size and effort

70–95 drills shipped after the stability filter (survey's 90–115 raw minus exclusions). Quota: ~1–1.5 "Expansion-0 units" (~15–25% of the weekly bar); waves launch early in fresh 5-hour windows per the adaptive protocol.

## Process

SDD as before: triage task first (D2), then authoring waves (D3, D4, D5+D6) each with fresh implementers + task reviews + fix rounds, D7 independent (can run parallel to any content wave — different repo), Fable whole-branch final review over the pack + the atrophy polish diff, then push Java-OAs master and update the atrophy PRs if D7 lands.
