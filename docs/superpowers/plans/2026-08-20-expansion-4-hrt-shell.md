# Expansion-4: HRT ETSE pack + shell graded language — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `shell` as a full graded language (knowledge + real execution, Design B) and `atrophy-pack-hrt` (~230–250+ drills including every viable executable-shell row from two surveys), plus the E2/E3 residual closure — nothing deferred (user order 2026-08-20).

**Architecture:** Five serial engine tasks on atrophy `feat/shell-language`, a supplementary executable-shell survey in parallel (read-only), then the roster-first content pipeline on Java-OAs with worktree-per-wave parallelism (≤3 concurrent). Executable-shell waves dispatch only after the engine merges.

**Tech Stack:** TypeScript/zod, vitest, Node `spawn` sandbox (`engine/runner.ts`), Git Bash ≥ 4 discovery, JSON exercise bank.

**Spec:** `docs/superpowers/specs/2026-08-20-expansion-4-hrt-shell-design.md` — binding. Prework artifacts in `.superpowers/sdd/2026-08-19-expansion-4-prework/` are evidence.

## Global Constraints

- Traveling law: E2/E3 binding rules verbatim (claim-verification gate; no-epsilon exactness; determinism; leak discipline; rubric bullets are DISPLAYED per engine/session.ts:540; output-cap conventions).
- PRIVACY HARD LAW per spec §2 Non-goals: zero-drill zones by file/line; the needle list lives in spec §2 and ONLY there (this plan deliberately does not echo it — the spec is the single permitted occurrence site; sweeps reference needles by index); no named individuals, attributed quotes, compensation, employment history, firm business intel; industry-mechanics framing; word-boundary grep mandatory pre-commit on every tracked file AND every report.
- Execution-derivation gate (spec §5.1): every numeric expectation and every `expectedStdout` computed by executing the reference, never transcribed; divergences tabled.
- Shell determinism laws (spec §4.2–4.5): CR-strip submitted scripts; `SHELL_ENV` pins (`LC_ALL=C`, `LANG=C`, `TZ=UTC`, `MSYS_NO_PATHCONV=1`, `MSYS2_ARG_CONV_EXCL=*`, PATH pinned `dirname(bash)` first); `PINNED_TOOLS` only; no `&`/`disown`/`nohup`, no absolute paths, no `date +%Z`, no `$RANDOM`/`$$`/`$SECONDS`, sorted associative iteration; ≥2 discriminating cases; echo-cheese must fail; P2 command-not-found-on-pinned-tool = harnessError never a score.
- Repos: atrophy on `feat/shell-language`; pack on Java-OAs master, staged by name. Gates from the `feat/shell-language` checkout: pack-only `ATROPHY_BANK=<pack> npx vitest run bank/bank-integrity.test.ts`; merged `atrophy doctor` with all four packs on `ATROPHY_PACKS` (`;`-separated) — 639 + roster, zero collisions, track `hrt`; re-grades via `npx tsx cli/index.ts drill --exercise <id> --solution <file>` with scratch `ATROPHY_DB` + `ATROPHY_NO_SYNC=1`. Never `npm run dev -- …`.
- Pacing: fan-out protocol only (ccusage ×1.6; >50% raw = no wave-sized dispatches in-block; ≤3 concurrent worktree waves). Weekly-limit deaths are accepted interruptions; worktrees + ledger make resume cheap.

---

### Task 0 (parallel, read-only): Supplementary executable-shell survey

**Files:** Create `.superpowers/sdd/2026-08-19-expansion-4-prework/shell-exec-survey.md` (git-ignored workspace artifact).

**Interfaces:** Produces the extended executable-shell candidate table T6 consumes: slug, topic, source citation, tier, kind=write, fixture sketch, case-discrimination idea, convert-vs-keep call for each §2f knowledge row, dedup against the original 35 and against DE Shaw. Runs concurrently with T1–T5 (no file contention — different repo, read-only).

- [ ] Mine `04` Module 1 (all challenges + sed/find/links/process material), `03` Part 11 (~1,150 lines), `02` Part A Q1–Q35 + gap fillers, `08` §2, `06` §10 ladder + §7 cheat table, `09` Day 1 for every candidate the engine contract can grade (spec §4.1 `shellCases`). Apply the conversion rule (spec §5) to all 82 §2f rows. Honest counts; privacy law binds the artifact too.

### Task 1: Schema — `shell` in `LANGUAGES` + `shellCases` (atrophy)

**Files:** Modify `bank/schema.ts` (LANGUAGES :13; codeFields; refinement ~185–222; `TestedExercise`/`CodeExercise` ~238–249; `totalUnits` ~291–309; `spawnsShell` beside `spawnsJvm` ~286–288); `cli/setup.test.ts:160/:201`; `cli/readme-claims.test.ts` + `README.md` (same commit); `engine/grader.ts:43–48` (`solution.sh`); `engine/session.ts:207–214` (`#`); `CLAUDE.md` (stale vitest-config claim). Test: the schema tests' colocated home.

**Interfaces:** Produces the parse contract every later task consumes: shell `write` requires `shellCases` (spec §4.1 shape verbatim — `files?`/`args?`/`expectedStdout`/`expectedExitCode?`, ≥2 cases differing in `(expectedStdout, expectedExitCode)`, relative `files` keys only); shell `fix`/`predict-output` rejected by name; `cloze`/`recall` accept shell; `spawnsShell(kind)` true for `write` only; `totalUnits` = `shellCases.length`.

- [ ] Failing tests first: 3 rejections (shell fix, shell predict-output, shell write with `tests`), 4 acceptances/validations (shell recall; shell cloze; shell write with 2 discriminating cases parses; shell write with identical-expectation cases rejects; absolute/`..` `files` key rejects) → run, verify fail → implement → `npx vitest run` + `npm run typecheck` green → commit `feat(schema): shell language with shellCases write arm`.

### Task 2: Toolchain — `engine/bashtool.ts` + doctor (atrophy)

**Files:** Create `engine/bashtool.ts` + `engine/bashtool.test.ts`; modify `cli/doctor.ts` (add `checkBash`, register in `runDoctor` ~426–437).

**Interfaces:** Produces `bashCommand(env)`, `hasBash()` (cached), `parseBashMajor`, `MIN_BASH_MAJOR = 4`, `missingBashHint`, `SHELL_ENV`, `PINNED_TOOLS` (spec §4.2 lists both). Discovery order and never-bare-`bash`-on-win32 per spec §4.2. `checkBash` warns-never-fails and reports resolved path + which discovery rule won.

- [ ] Unit tests for `parseBashMajor`, discovery-order resolution (injected fs/env fakes — never probe in unit tests), `SHELL_ENV` contents; doctor render split pure (`bashCheckResult`) → implement → suite green → commit.

### Task 3: Grader — `gradeShell` (atrophy)

**Files:** Modify `engine/grader.ts` (gradeShell + `grade()` dispatch lane ahead of the `isPy` fork); `engine/session.ts` if the loop needs the shell arm surfaced; test in `engine/grader.shell.test.ts` (`describe.skipIf(!hasBash())` with the SKIPPED warning).

**Interfaces:** Consumes T1's `shellCases` + T2's `bashCommand`/`SHELL_ENV`/`PINNED_TOOLS`. Produces `GradeResult` per spec §4.3: per-case fresh sub-dir, Node-written `files`, CR-stripped script, full `testTimeoutMs` per case, `normalizeOutput` stdout equality + exit code, no whitespace partial credit, named per-case failures with visible truncation, harnessError on spawn failure or the P2 pinned-tool signature, ordinary failure on non-pinned command-not-found.

- [ ] Tests first (behind skipIf): reference pipeline 1.00; wrong-answer sub-1.00 with named case; echo-cheese fails ≥1 case; exit-code mismatch fails; CRLF submission passes (CR-strip proven); fabricated bash path → harnessError; a script invoking a non-pinned tool → ordinary fail not harnessError → implement → suite green (JDK + bash both present locally) → commit.

### Task 4: Selection, gating, CLI reporting (atrophy)

**Files:** Modify `engine/select.ts` (`Toolchains` → `{jdk, bash}`; `hostToolchains`; `offerable` `needsBash`; `hiddenByToolchain` → `{jdk: number, bash: number}` breakdown; `availableAxes`; the full-toolchain arm literal); `cli/index.ts` (empty-pool hint by requested language; shrunken-pool notices); `cli/doctor.ts` notice sibling; tests colocated.

**Interfaces:** Consumes T2's `hasBash`. Produces the honest breakdown with the anti-double-count law extended (one bucket per drill; `hiddenByLanguages` unchanged on real toolchains both arms). Injected `toolchains: {jdk, bash}` everywhere tests touch selection.

- [ ] Tests: bash-less host hides shell `write` but serves shell cloze/recall; breakdown counts each hidden drill exactly once under jdk XOR bash; `--lang shell` empty-pool error names `ATROPHY_BASH`; jdk-only and bash-only hosts each get the right message → implement → suite + typecheck green → commit.

### Task 5: Integrity gates for shell content (atrophy)

**Files:** Modify `bank/bank-integrity.test.ts` (shell suite behind `describe.skipIf(!hasBash())` + SKIPPED warning).

**Interfaces:** Consumes T1–T3. Produces the gates W7+ ships against: reference grades 1.00 by execution; double-run determinism diff; synthesized echo-cheese (case 1's `expectedStdout` verbatim) fails ≥1 case; grep backstop for `&`/`disown`/`nohup`, absolute paths, `date +%Z`, `$RANDOM`/`$$`/`$SECONDS`, non-pinned tools; zero-shell banks pass vacuously EXCEPT the base bank (which ships none — assert that stays true, mirroring the zero-jvm-java precedent inverted).

- [ ] Tests + a temporary in-test fixture exercise (constructed inline, not shipped) proving each gate fires → commit → **push `feat/shell-language`; verify CI green on both OS legs including windows-latest bash discovery without PATH help; if Git for Windows is absent there, add the explicit setup step to `.github/workflows/ci.yml` in a follow-up commit.**

### Task 6: Roster + pack scaffold (Java-OAs)

**Files:** Create `atrophy-pack-hrt/pack.json` = `{"name": "hrt"}`, `MANIFEST-HRT.md`.

**Interfaces:** Consumes both surveys + spec §5 laws. Produces the FINAL roster: per-row id/kind/axis/language/tier/source/wave, re-angle/cut/convert rulings with reasons (dedup rulings spec §5.4; api-memory ≤ 35%; S6/S10 → predict-output; conversion table for §2f rows; executable-shell rows from both surveys). Waves W1–W6 content, W7+ executable shell at ~35 rows/wave.

- [ ] Roster → manifest skeleton (conventions, empty divergence table, privacy attestation) → privacy grep zero → commit staging the two files by name.

### Tasks W1–W8+: Content waves (worktree-per-wave, ≤3 concurrent)

Per spec §5 Waves. W1 python graded-code (execution-derivation wave; S1/S2/S3 recompute mandatory); W2 python cloze/recall + probability; W3/W4 shell knowledge I/II (+shell-tagged networking); W5 `any` networking + kernel/HFT; W6 trading + sql (fixtures from scratch, ≥2 differing cases) + outline; W7+ executable shell — **only after T1–T5 merged**, each wave gates with real bash from its worktree.

Per wave: - [ ] author exactly its roster rows → - [ ] self-grade references 1.00 + violators sub-1.00 via CLI (scratch DB, NO_SYNC) → - [ ] pack integrity green from the worktree → - [ ] privacy grep zero → - [ ] commit content then stamps → controller merges `--no-ff` serially → execution-verified review + fix rounds.

### Task 14: E2/E3 residual closure (Java-OAs `atrophy-pack/`, `atrophy-pack-amazon/`)

- [ ] Fix stale DSA-manifest line-citations (1993–1995/1888); add expansion-2 stamp form to the build-status legend; add dp-15 Q10/Q12 interval-DP note; recut `rm-dup-ii`; harden single-witness fixtures; fold the twin-gate-table maintenance note into MANIFEST-AMAZON.md. Re-gate every touched drill (integrity + re-grade); privacy grep; commit per pack.

### Task 15: Build status + consistency

- [ ] Bijection roster↔files; stamps → content SHA; four histograms re-derived from shipped JSONs; divergence + conversion tables complete; merged doctor all four packs (639 + roster, zero collisions, `hrt` correct); 3+ seeded re-grades incl. one executable-shell row with an independently written reference; build-status; commit.

### Final: Fable whole-branch review — both repos

Privacy sweep headline (needles + human read over every added line); cross-pack leak sweep (DE Shaw hot zones: state-machine, P&L, SQL buckets, plus the four re-angled rows); manifest coherence; engine re-verification (rejections, gradeShell invariants, breakdown counts, CI state); sampled re-grades; merged doctor. Verdict gates the push of both repos and PR-body updates.
