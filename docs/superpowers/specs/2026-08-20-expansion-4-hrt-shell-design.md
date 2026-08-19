# Expansion-4: HRT ETSE corpus pack + `shell` as a graded language — Design

**Date:** 2026-08-20 · **Status:** APPROVED — user order "No deferring, we complete everything in this effort" (2026-08-20, ~01:15 IST). Nothing in this expansion is deferred: the shell execution engine, the 35 executable-shell drills, the full content slice, and the parked E2/E3 residuals all ship here.
**Inputs (binding evidence):** `.superpowers/sdd/2026-08-19-expansion-4-prework/corpus-survey.md` (280-candidate enumeration, dedup scan, corpus-quality flags, privacy classification, answer-key audit) and `shell-engine-scout.md` (probe-backed engine facts P1–P17, execution designs A–E, determinism rules 1–15). Every ruling cites its evidence.

## 1. Goal

Ship the program's fourth and largest expansion in one effort:

1. **`shell` joins `LANGUAGES` as a full graded language** — knowledge drills (cloze/recall, in-process) AND executable `write` drills graded by really running the user's script under bash (Design B: Node-orchestrated per-case runs, comparison in TypeScript).
2. **`atrophy-pack-hrt`** (track `hrt`, ids `hrt-`): the survey's full recommended band — **~230–250 drills as the floor** — including the program's first Python graded content and ALL viable executable-shell rows: the 35 already enumerated are a first cut, not a ceiling (user order 2026-08-20: "we can have more than 35 executable shell drills"). A supplementary executable-shell survey re-mines the corpus for every candidate the engine contract can grade — including §2f knowledge rows that convert honestly to executable form — and the roster consumes both surveys.
3. **Residual closure**: the E2 backlog (stale manifest line-citations, build-status legend, dp-15 interval-DP note, rm-dup-ii recut, single-witness fixtures) and the E3 twin-gate-table note.

## 2. Scope

**In scope:** everything in §1. **Out of scope** (not deferrals — these have no corpus content or are ruled out on evidence): `expectedFiles` file-state grading; shell `fix` / `predict-output` / harness kinds (all 35 executable candidates are `write` — survey §2e; the schema rejects the empty kinds by name exactly as sql does); WSL as an execution target (scout §2D: 6.5 s cold start, `/mnt/c` path divergence); a macOS CI leg (macOS's bash 3.2 hides shell-exec content via `hiddenByToolchain`); `06` Section 8 (no answer keys — survey §4.4).

**Non-goals — PRIVACY HARD LAW (extends the E3 law; every review layer greps)**

Zero drills, zero quoted or paraphrased text, in ANY tracked file, from: `07_Behavioral_Answers.md` (entire); `09` Part 3 (~1465–1680), Part 1 narrative (~24–100, ~440–520), Day 6 (~1284–1300); `08` §4 (~822–996) + the Pre-Interview Checklist block (~209); `06` §0 compensation (~79–89), Appendix B (~1104–1153), Appendix C (~1336–1362), §8; `05` Part 5 (1297–1390); `03` 2580–2595; `02` Q76/Q82/Q83 employer asides + behavioral checklist (~6534–6541) — surrounding technical answers usable once asides are stripped; `01` §2.4's home-directory name.

Grep needles (word-boundary, case-insensitive): the E3 codename set (finra, RAMS, ICCR, ETR, Email2Db) **plus** `Goldman`, `GS compliance`, `hackathon`, `Glassdoor`, `Blind`, `InterviewDB`. Banned by classification: named individuals, attributed quotes, compensation figures, the user's employment history, firm business intel (headcount/revenue/hires/offices). Framing rule: industry mechanics ("in a colocated market-making system…"), never "at HRT we…". The firm name appears only as the track name `hrt` in `pack.json` and the manifest provenance header (amazon-pack precedent).

## 3. Architecture

Same SDD machinery as E2/E3. Two repos:

- **atrophy** — branch `feat/shell-language` (off `feat/java-language-support`): five engine tasks (schema → toolchain → grader → selection/CLI → integrity gates), serial in the main checkout.
- **Java-OAs** — `atrophy-pack-hrt/` on master, staged by name; plus the residuals task touching `atrophy-pack/` (DSA manifest + two drills). Gates run from the `feat/shell-language` checkout.

Flow: T1–T5 engine → T6 roster → waves W1–W7 (worktree-per-wave, ≤3 concurrent; W7 = executable shell, dispatched only after T1–T5 merge) → T14 residuals → T15 consistency → Fable final → push both repos.

## 4. Engine design

### 4.1 Schema (T1)

- `LANGUAGES` gains `"shell"` appended last (`bank/schema.ts:13`) — keeps setup menu numbering stable.
- **Shell `write` is structurally the sql case** (scout §1.2): no `functionName`/`tests`; instead `shellCases`:

  ```ts
  shellCases: z.array(z.object({
    files: z.record(z.string(), z.string()).optional(), // relative path -> contents; staged fresh per case
    args: z.array(z.string()).optional(),                // argv for the script
    expectedStdout: z.string(),
    expectedExitCode: z.number().int().min(0).max(255).optional(), // default 0
  })).min(2)
  ```

  Refinement rules: shell `write` requires `shellCases` and forbids `tests`/`cases`/`functionName`; ≥2 cases must differ in their `(expectedStdout, expectedExitCode)` pair (the sql "different rows" anti-hardcoding twin — `echo` of a literal answers a one-case drill); `files` keys are relative, no `..`, no leading `/` or drive letter. Nested relative paths are valid: the grader's stager creates parent directories (ruling on the supplementary survey's engine question — the find/xargs cluster needs `d1/z.log`-shaped fixtures). `fix` and `predict-output` reject `language: "shell"` by name (message says the corpus ships no such content and names the kinds that do). Harness kinds stay `java`-pinned. `cloze`/`recall` accept `"shell"` with no change.
- Typing ripple (scout §1.2): `TestedExercise` excludes `"sql" | "shell"`; `CodeExercise` gains the shell member; `totalUnits` counts `shellCases.length`; `spawnsShell(kind)` beside `spawnsJvm` — true for `write` only.
- Consumer touchpoints: `cli/setup.test.ts:160/:201` (hardcoded 4-language assertions), `cli/readme-claims.test.ts` + README `--lang` row (same commit), `engine/grader.ts:43–48` → `solution.sh`, `engine/session.ts:207–214` → `#` comment prefix (kills the `//`-into-bash fallthrough). `cli/index.ts`/`config.ts`/`setup.ts`/`doctor.ts` interpolate `LANGUAGES` — verify, no edits expected. CLAUDE.md's stale "no vitest config file" claim corrected.

### 4.2 Toolchain discovery — `engine/bashtool.ts` (T2)

The `javatool.ts` sibling (scout §3.1, all steps probe-verified):

- `ATROPHY_BASH` — verbatim full-path override (the `ATROPHY_PYTHON` shape). The user may point it anywhere, including WSL, at their own documented risk.
- Discovery on win32: (1) `ATROPHY_BASH`; (2) derive from `git --exec-path` → up three → `<root>\usr\bin\bash.exe` (P16); (3) well-known installs (`C:\Program Files\Git\usr\bin\bash.exe`, x86 variant, scoop/choco shims). **Never bare `bash` from PATH on win32** — it resolves to the WSL launcher (P1). POSIX: `ATROPHY_BASH`, `/bin/bash`, then PATH.
- `hasBash()` cached probe (`spawnSync(bash, ["-c", "echo $BASH_VERSION"])`); `parseBashMajor` ("5.2.37(1)-release" → 5); `MIN_BASH_MAJOR = 4` — below-floor hosts hide shell-exec drills, never an install demand; `missingBashHint` names `ATROPHY_BASH`.
- `SHELL_ENV` — the `JAVA_RUNTIME_FLAGS` analog, env not argv: `LC_ALL=C`, `LANG=C`, `TZ=UTC`, `MSYS_NO_PATHCONV=1`, `MSYS2_ARG_CONV_EXCL=*`, and `PATH` pinned with `dirname(bash)` first (P2/P3: without the pin every coreutil is command-not-found and the script still exits 0). All six are determinism pins with probe receipts (P6/P7/P11).
- `PINNED_TOOLS`: the core set every drill may assume (P14 intersection): `ls cat grep sed awk cut sort uniq tr head tail wc find xargs tee printf seq basename dirname date sleep env comm join paste nl fold od mktemp readlink stat du diff tac split expr`. Not in the set (P14 absent): `jq`, `python`, `curl`, `rev` — a drill invoking them is an authoring error the integrity gate catches by execution.

### 4.3 Grader — `gradeShell` (T3)

Design B (scout §2B). Loop `shellCases` in TypeScript: per case, fresh sub-scratch dir; write `files` (by Node, not a shell prelude); copy in the submitted script **with `\r` stripped** (rule 1 — CRLF passes on msys and fails on glibc); `run(bashPath, [solutionPath, ...args], {cwd, env: SHELL_ENV, timeoutMs})` — each case gets the full `testTimeoutMs` (java's separate-compile-budget precedent); compare `normalizeOutput(stdout)` equality + exit code in-process, building `GradeResult` directly. No marker, no JSON-from-bash. `WHITESPACE_PARTIAL_CREDIT` does **not** apply (in a pipeline drill the alignment often is the answer).

Verdicts: pass / fail (named per case, stderr excerpt attached, truncation-visible per rule 14) / **harnessError** — spawn rejection, or the P2 signature (stderr `command not found` naming a `PINNED_TOOLS` member = broken toolchain, never evidence about the user). `command not found` for a non-pinned tool is an ordinary failure — the user reached for a tool the contract doesn't provide. Runner unchanged: fixtures may not background (`&`, `disown`, `nohup` — integrity-enforced); the pathological user-answer orphan (P13) is documented and bounded by the drill's own commands. `grade()` gains the shell lane ahead of the `isPy` fork.

### 4.4 Selection, gating, CLI reporting (T4)

- `Toolchains` becomes `{ jdk: boolean; bash: boolean }`; `hostToolchains()` probes both; `offerable` adds `needsBash = c.language === "shell" && spawnsShell(c.kind)`.
- **`hiddenByToolchain` returns the honest breakdown `{ jdk: number; bash: number }`** (ruling: scout §3.2 option (a)) with the anti-double-count law extended: a drill is counted in exactly one bucket, and `hiddenByLanguages` still uses real toolchains on both arms.
- CLI: the empty-pool branch and the shrunken-pool notices name the right culprit per requested language (`missingJdkHint` / `missingBashHint`); `hiddenJavaNotice` gains a shell sibling. Narrowing is never silent — the invariant stands.
- Doctor: `checkBash` mirrors `checkJava` (probe directly, pure render split, **warn never fail**) and additionally reports *which discovery rule won* and the resolved path (`…\usr\bin\bash.exe: GNU bash 5.2.37 (via git --exec-path)`) — the user's real question is "did it find Git Bash or WSL?".

### 4.5 Integrity gates (T5)

Shell twins of the existing gates, in `bank/bank-integrity.test.ts`, `describe.skipIf(!hasBash())` with the java-style "SKIPPED" warning: every shell reference solution grades 1.00 by actually running; every fixture double-runs deterministically (the sql build-twice precedent); the synthesized cheese — a script that `echo`s case 1's `expectedStdout` verbatim — fails at least one case; no `&`/`disown`/`nohup` and no non-`PINNED_TOOLS` invocation in shipped scripts/fixtures (execution catches the latter; a grep backstop catches both); no absolute paths, no `date +%Z`, no `$RANDOM`/`$$`/`$SECONDS`, no unordered associative-array iteration without `sort` (scout rules 3, 7–9). CI: `windows-latest` ships Git for Windows — the first push of `feat/shell-language` verifies discovery-without-PATH in a real run; if absent, the workflow adds an explicit Git-for-Windows setup step.

## 5. Content design

**Pack identity.** `atrophy-pack-hrt/pack.json` = `{"name": "hrt"}`; `MANIFEST-HRT.md` carries roster, stamps, gate tables, divergence table, build status (E3 conventions).

**Roster source.** The survey §2 enumeration plus the supplementary executable-shell survey (`shell-exec-survey.md`, same prework dir) ARE the candidate list. T6 rosters from them — never from corpus files directly — by **topic wave, never corpus file** (survey §4.5). Target: ~230–250 as the floor; the executable-shell count lands wherever the supplementary survey's honest enumeration lands. Conversion rule: a §2f knowledge row whose fact is *a command's observable effect* converts to executable (running it IS the honest grade); a row whose fact is conceptual ("why", "which state", "what does X mean") stays recall/cloze — the conversion table records each call with its reason.

**Binding content laws** (traveling law = E2/E3 rules verbatim, plus):

1. **Execution-derivation gate** (survey §4.1 — three "Expected Output" blocks are arithmetically wrong, execution-verified): every numeric expectation in a python `fix`/`write`/`predict-output` and every shell `expectedStdout` is generated by executing the reference, never transcribed. Divergences tabled in the manifest (S1 $200 transposition, S2 self-contradiction, S3 sign error are known).
2. **S6/S10 become `predict-output`**, hints ignored (survey §4.2).
3. **Stdlib-only python** (survey §4.3): candidate 12 rewritten around dict+`sorted()` or `heapq`; no third-party imports anywhere.
4. **Dedup rulings** (survey §3): 149 re-asks *why* `kill -9` fails on D-state; 237 re-asks `35=8`+`150=1`; 150/181 cut unless T6 pins a distinguishably different fact; same-concept-different-language rows (13, 15, 11, 191, 224, 62) keep explicit language framing; hrt-sh-fix-msgtypes (74) drops or reframes per the DE Shaw collision map.
5. **api-memory ≤ 35%** of the final roster: convert to cloze where a crisp blank exists, cut the rest, each with a reason.
6. Candidate 59 pins CPython + a capacity transition, never the headline factor (survey §4.6). `09` Part 1: technical passages only (§4.7).
7. **Shell fixture law** (survey §4.8 + scout §4): the `04` Module 1 log fixtures are generated ONCE, pinned as literal `files` content in each drill's `shellCases` — never regenerated; every fixture obeys the determinism rules (relative paths, no `%Z`, sorted iteration, pinned tools). Additional probe-established laws from the supplementary survey (§1 S1–S14 there, binding on every shell drill): **no `grep -P`/`\K` anywhere** — it exits 2 under `LC_ALL=C` on the msys toolchain; use the probed POSIX extractions (`grep -o`+`cut`, `sed -n 's/…/\1/p'`, or `awk -F`); no `du`-based size ranking (block-size dependent — rank by `wc -c`); every `find` pipes through `sort`; no `ls -l` in expectations; `uniq -c` expectations must be execution-generated (7-wide count padding); shebang lines are inert under `bash script.sh` invocation.
8. **Dual-toolchain gate for executable shell (user-adopted 2026-08-20; Docker CLI 29.6.1 present on host).** The determinism laws argue msys ≡ glibc; this gate proves it per drill before CI ever sees it. Every W7+ wave gate runs each shell drill's reference (must grade 1.00) and its cheese (must stay sub-1.00) under BOTH toolchains: the host's Git Bash (msys) AND a pinned Linux image — `ubuntu:24.04`, chosen to mirror CI's ubuntu-latest (never the `bash` image: it is Alpine/BusyBox, whose coreutils are a third dialect). `expectedStdout` must be byte-identical across both; a divergence is an authoring error caught at the wave gate, not a red CI leg. Mechanics: mount the wave's staging dir, run the per-case script batch inside one container per wave (not per case). Fallback: if the Docker daemon is down at wave time, the wave report says so LOUDLY and CI remains the Linux check — the gate is binding when available, never silently skipped.
9. **Claim-verification gate, no-epsilon exactness, leak discipline, output-cap conventions** — verbatim from the traveling law. Rubric bullets are DISPLAYED (engine/session.ts:540).
10. **Answer-key honesty** (survey §6): sql fixtures authored from scratch; Module 9 S7 / Module 2 fixed-code derived by execution; `06` §9 items 11–12 excluded.

**Waves.** W1 python graded-code (fix/write/predict-output — the execution-derivation wave); W2 python cloze/recall + probability + amortized; W3 shell knowledge I; W4 shell knowledge II + shell-tagged networking; W5 `any` networking + kernel/HFT; W6 trading-domain + sql + outline; **W7+ executable shell (all `write` rows from both surveys; splits into W7/W8/… at ~35 rows per wave)** — dispatched only after T1–T5 merge, gates with a real bash. Worktree-per-wave, own scratch DB, `ATROPHY_NO_SYNC=1`, per-wave manifest row stamps.

**Gates.** Pack-only integrity from `feat/shell-language`; merged doctor with **all four packs** — expected 639 + roster, zero collisions, track `hrt` listed; CLI re-grades per drill kind.

## 6. Residual closure (T14)

From the E2 ledger backlog: fix stale manifest line-citations (1993–1995/1888), add the expansion-2 stamp form to the build-status legend, add the dp-15 Q10/Q12 interval-DP note, recut `rm-dup-ii`, harden the single-witness fixtures. From E3: fold the twin-gate-table note into MANIFEST-AMAZON.md maintenance guidance. All content changes re-gate (integrity + re-grade of touched drills).

## 7. Scheduling (binding)

Everything executes now, paced only by the fan-out protocol (ccusage ×1.6; >50% raw = no wave-sized dispatches within a block; big waves early in fresh blocks; ≤3 concurrent worktree waves). A weekly-limit death is an accepted interruption, not a plan input: worktrees + the ledger make resume cheap, and the effort continues at the next reset without re-scoping.

## 8. Success criteria

- `--lang shell` serves knowledge drills on any host and executable drills where bash ≥ 4 is discovered; a bash-less host sees the honest `{jdk, bash}` hidden-count breakdown and a doctor line naming the resolved path or the fix; graded-code kinds other than `write` reject shell at parse.
- All shell grading honors the standing invariant: a broken toolchain (P2 signature, spawn failure) is a `harnessError`, never a score.
- `atrophy-pack-hrt` ships ~230–250 drills, all gates green, zero privacy hits at every layer, merged doctor clean across four packs.
- E2/E3 residuals closed and re-gated. Full suite + typecheck green on `feat/shell-language`; CI green on both OS legs including real bash discovery on windows-latest.
