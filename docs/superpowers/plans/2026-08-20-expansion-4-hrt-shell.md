# Expansion-4: HRT ETSE pack + shell knowledge language — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Widen `LANGUAGES` with knowledge-only `"shell"`, then ship `atrophy-pack-hrt` (~200–215 drills, the program's first Python content) from the HrtEtse corpus survey's enumeration.

**Architecture:** One small engine task on a new atrophy branch, then the E3 roster-first content pipeline on Java-OAs with E2's worktree-per-wave machinery. Six topic waves, consistency task, Fable final.

**Tech Stack:** TypeScript/zod (schema), vitest, the existing CLI grading paths (python/node/sql in-process + subprocess), JSON exercise bank.

**Spec:** `docs/superpowers/specs/2026-08-20-expansion-4-hrt-shell-design.md` — the binding authority. The two prework artifacts it cites are evidence, not requirements.

## Global Constraints

- Traveling law: Expansion-2/3 binding rules verbatim (claim-verification gate; no-epsilon exactness; determinism — injected timestamps, canonical orders; leak discipline cross-pack and within-pack; rubric bullets are DISPLAYED per engine/session.ts:540; output-cap conventions).
- PRIVACY HARD LAW as extended in spec §2 Non-goals: zero-drill zones by file/line; needles = E3 codename set + `Goldman`, `GS compliance`, `hackathon`, `Glassdoor`, `Blind`, `InterviewDB`; no named individuals, attributed quotes, compensation, employment history, or firm business intel; industry-mechanics framing; word-boundary grep mandatory pre-commit on every tracked file AND every report.
- Execution-derivation gate (spec §5.1): numeric expectations from `04` are computed by running the reference, never transcribed; divergences tabled.
- Repos: atrophy work on `feat/shell-language` (off `feat/java-language-support`); pack work on Java-OAs master, staging `atrophy-pack-hrt/` paths by name only.
- Gates: pack-only `ATROPHY_BANK=<pack> npx vitest run bank/bank-integrity.test.ts` from the `feat/shell-language` checkout; merged `atrophy doctor` with all four packs on `ATROPHY_PACKS` (`;`-separated) — expect 639 + roster size, zero collisions, track `hrt` present; CLI re-grades via `npx tsx cli/index.ts drill --exercise <id> --solution <file>` with scratch `ATROPHY_DB` + `ATROPHY_NO_SYNC=1`. Never `npm run dev -- …` (Windows npm eats flags).
- Quota (spec §6): T1+T2 may run this week after user spec review; waves W1–W6 + final start at the Aug 25 weekly reset. Fan-out protocol binds (ccusage ×1.6; >50% raw = no wave dispatches; ≤3 concurrent worktree waves).

---

### Task 1: `shell` joins `LANGUAGES` (knowledge-only)

**Files:**
- Modify: `bank/schema.ts` (line 13 `LANGUAGES`; the cross-field refinement ~185–222)
- Modify: `cli/setup.test.ts:160, :201` (hardcoded 4-language assertions)
- Modify: `cli/readme-claims.test.ts` fixture if it pins the language list; `README.md` `--lang` row (same commit)
- Modify: `engine/grader.ts:43–48` (solution filename map → `solution.sh`), `engine/session.ts:207–214` (comment prefix → `#`)
- Modify: `CLAUDE.md` (delete the stale "there is no vitest config file" claim)
- Test: `bank/schema.test.ts` (or the schema tests' actual home — colocated `*.test.ts`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `"shell"` as a valid concrete `Language` accepted by `cloze` and `recall` (and the `Language | "any"` shape), **rejected by name** on `write`/`fix`/`predict-output` with an error stating shell code drills await the execution engine. Every wave task relies on this parse behavior.

- [ ] **Step 1: Write the failing tests** — three rejection cases (a shell `write` with `cases`, a shell `fix`, a shell `predict-output` — each expects a parse error whose message names shell and the deferral) and two acceptance cases (a shell `recall`, a shell `cloze` with one blank). Model them on the existing sql-rejection tests beside the refinement's current coverage.
- [ ] **Step 2: Run to verify they fail** — `npx vitest run bank/schema.test.ts` (rejections fail because `"shell"` is not yet a `Language`; the error is a different one than asserted — that counts as failing).
- [ ] **Step 3: Implement** — append `"shell"` to `LANGUAGES` at `bank/schema.ts:13`; add the rejection arm in the refinement beside the sql-rejects, same error style; add the `solution.sh` and `#` arms; fix the two `cli/setup.test.ts` assertions (menu now 5 entries; `6` is the out-of-range pick; the `"1,3"` comment survives because shell appended last); update README's `--lang` row and anything `readme-claims` recomputes; correct CLAUDE.md's vitest-config sentence.
- [ ] **Step 4: Full verification** — `npx vitest run` (entire suite) + `npm run typecheck`. Expected: green, zero java skips if a JDK is present.
- [ ] **Step 5: Commit** on `feat/shell-language` — `feat(schema): shell as a knowledge-only language`.

### Task 2: Roster + pack scaffold (`atrophy-pack-hrt`)

**Files:**
- Create: `Java-OAs/atrophy-pack-hrt/pack.json` = `{"name": "hrt"}`
- Create: `Java-OAs/atrophy-pack-hrt/MANIFEST-HRT.md`

**Interfaces:**
- Consumes: the survey enumeration (§2 tables, by row number) and spec §5's ten binding laws.
- Produces: the FINAL roster — per-row: id, kind, axis, language, tier, source citation, wave assignment (W1–W6), and any re-angle/cut ruling with its reason. Every wave task authors exactly its roster rows; deviations require a controller ruling.

- [ ] **Step 1: Roster** from the survey's 280 rows minus tier-E (35), applying: dedup rulings (spec §5.5 — 149/237 re-angled as specified, 150/181 cut unless a distinguishably different fact is pinned, language-framing rule on 13/15/11/191/224/62), api-memory ≤ 35% (convert-to-cloze or cut, each with a reason), S6/S10 → predict-output, candidate 12 stdlib-only rewrite noted, candidate 59 reframed per spec §5.7. Target 200–215; the number lands where the rulings land — never pad, never silently drop.
- [ ] **Step 2: Manifest skeleton** — roster table, conventions section citing the spec, the execution-derivation divergence table (empty, headed), privacy attestation line (grep run, zero hits), wave plan.
- [ ] **Step 3: Privacy grep** over both files and the report; zero hits required.
- [ ] **Step 4: Commit** on Java-OAs master, staging the two files by name — `feat(pack): atrophy-pack-hrt scaffold + expansion-4 roster`.

### Tasks 3–8: Content waves W1–W6 (worktree-per-wave, ≤3 concurrent, start ≥ Aug 25 reset)

**Files per wave:** Create `Java-OAs/atrophy-pack-hrt/exercises/<axis>/<id>.json` for exactly the wave's roster rows; stamp only its own manifest rows.

**Interfaces:** Consumes Task 1's parse behavior (shell tags), Task 2's roster rows verbatim, and the spec's content laws. Produces gate-green drills: references 1.00 via the real CLI, violators sub-1.00 tabled per claim, pack integrity green, no cross-wave file contention (waves own disjoint exercise files; manifest row-stamping is per-wave by row).

Wave contents (roster may re-shuffle within reason): **W1** python graded-code — all `fix` + `write` + `predict-output`; every expected value produced by executing the reference (spec §5.1), divergence table appended; S1/S2/S3 recomputation mandatory. **W2** python cloze/recall + probability + amortized-complexity rows. **W3** shell knowledge I (survey §2f first half). **W4** shell knowledge II + shell-tagged networking. **W5** `any` networking + kernel/HFT tuning. **W6** trading-domain + sql `write` (fixtures authored from scratch, ≥2 cases with different rows, cheese-gate aware) + outline (rubrics must not leak sibling recall answers).

Per-wave steps: - [ ] author drills → - [ ] self-grade references 1.00 + violators sub-1.00 through the CLI (scratch DB, NO_SYNC) → - [ ] pack integrity green from the wave worktree → - [ ] privacy grep zero → - [ ] commit (content, then stamps) → controller merges `--no-ff` serially, then execution-verified review + fix rounds per SDD.

### Task 9: Build status + consistency

- [ ] Bijection roster↔files; stamps → the content SHA; histograms (kind/axis/language/tier) re-derived from shipped JSONs; divergence table complete; merged doctor with all four packs — expected total = 639 + roster size, zero collisions, track `hrt` correct; 3 seeded re-grades with independently written references; build-status section; commit.

### Final: Fable whole-branch review (both repos' E4 ranges)

Privacy sweep headline (spec Non-goals needles over every added line + human read), cross-pack leak sweep (DE Shaw is the hot adjacency — survey §3's strong/moderate zones: state-machine, P&L, SQL buckets), manifest coherence, engine-task re-verification (the three rejections + suite green), sampled re-grades, merged doctor. Verdict gates the push of both repos.
