# Expansion-4: HRT ETSE corpus pack + `shell` as a knowledge language — Design

**Date:** 2026-08-20 · **Status:** drafted overnight for user review; implementation gated on that review
**Inputs (binding evidence):** `.superpowers/sdd/2026-08-19-expansion-4-prework/corpus-survey.md` (280-candidate enumeration, dedup scan, corpus-quality flags, privacy classification, answer-key audit) and `shell-engine-scout.md` (probe-backed engine facts, execution designs, 10 open questions). Every ruling below cites its evidence.

## 1. Goal

Ship the program's fourth expansion: a new exercise pack `atrophy-pack-hrt` (track `hrt`, id prefix `hrt-`) of roughly **200–215 drills** mined from the HrtEtse corpus — the program's **first Python graded content** — plus one small engine change: **`"shell"` joins `LANGUAGES` as a knowledge-only language** (cloze/recall tags, in-process grading, zero execution). The shell *execution* engine and the 35 drills that need it are explicitly deferred to a follow-on effort (§8).

## 2. Scope

**In scope**
- Engine: widen the `Language` union with `"shell"`, knowledge-only (schema rejects `"shell"` on every graded-code kind, exactly as sql rejects `fix`/`predict-output` by name today). Full touchpoint list in §4.
- Content: the survey's tier-1 (163 authorable today) + tier-2 (82 unblocked by the widening) candidates = 245 gross, trimmed by dedup rulings, the api-memory cap, and roster judgment to the ~200–215 band. Kinds: python `fix`/`write`/`predict-output`/`cloze`/`recall`, sql `write`, `any` cloze/recall/outline, shell cloze/recall.
- Docs: README `--lang` row + five-skills table move with the bank (readme-claims test enforces this); CLAUDE.md's stale "there is no vitest config file" claim corrected (scout §1.8: `vitest.config.ts` exists).

**Out of scope (deferred to Expansion-4c, §8)**
- Real shell execution (bash probe, `gradeShell`, `spawnsShell`, fixtures, process-tree kill, CI bash verification) and the 35 tier-E `write` drills (survey §2e). Design B (Node-orchestrated per-case runs) is the shortlisted shape; the scout's 10 open questions carry provisional rulings in §8 but are **not** binding until E4c's own spec.
- `expectedFiles` grading, shell `fix`/`predict-output`, `write-harness` for shell — all explicitly not in v1 (scout §2 option C, §5 Q3/Q4/Q6).

**Non-goals — PRIVACY HARD LAW (extends the E3 law; the final review greps for these)**

Zero drills, zero quoted or paraphrased text, in ANY tracked file, from:
- `07_Behavioral_Answers.md` — entire file.
- `09` Part 3 (~1465–1680), Part 1 narrative (~24–100, ~440–520), Day 6 (~1284–1300).
- `08` Section 4 (~822–996) and the Pre-Interview Checklist block around line ~209.
- `06` Section 0 compensation (~79–89), Appendix B (~1104–1153), Appendix C (~1336–1362), and Section 8 (no answer keys — survey §4.4, excluded for content reasons too).
- `05` Part 5 (1297–1390).
- `03` lines 2580–2595 ("Reapplication Reality"); `02` Q76/Q82/Q83 employer asides and the behavioral checklist (~6534–6541) — the surrounding technical answers are usable once the asides are stripped.
- `01` §2.4's home-directory name if that block is ever quoted.

Grep needles (word-boundary, case-insensitive) for every review layer: the E3 codename set (finra, RAMS, ICCR, ETR, Email2Db) **plus** `Goldman`, `GS compliance`, `hackathon`, `Glassdoor`, `Blind`, `InterviewDB`. Additionally banned by classification rather than needle: any named individual, any verbatim quote attributed to a person, compensation figures, the user's employment history, any assertion about the firm's headcount/revenue/hires/offices. Framing rule (survey §5): drills state *industry* mechanics — "in a colocated market-making system…", never "at HRT we…". The firm's name appears in exactly one tracked place: `pack.json`'s track name `hrt` and the manifest's provenance header, mirroring the sanctioned-track-name precedent from the amazon pack.

## 3. Architecture

Same SDD machinery as E2/E3: controller + fresh implementer per task, execution-verified reviews, fix rounds, Fable whole-branch final. Two repos:

- **atrophy** — new branch `feat/shell-language` off `feat/java-language-support` (bb0095c). Carries the widening task and these docs. Separate future PR; PR #1 stays as-is.
- **Java-OAs** — `atrophy-pack-hrt/` on master, staged by name only (repo dirt untouched). Gates run from the atrophy checkout on `feat/shell-language` (shell-tagged JSONs only parse against the widened schema).

Data flow: T1 engine widening → T2 roster (the binding per-row rulings, E3 pattern) → content waves W1–W6 (worktree-per-wave, ≤3 concurrent, E2's proven machinery) → consistency task → Fable final → push.

## 4. Engine design: `shell` as a knowledge-only language

One schema line plus an enumerated blast radius (scout §1.1, all receipts verified):

| Site | Change |
|---|---|
| `bank/schema.ts:13` | `LANGUAGES` gains `"shell"` (appended last — keeps setup menu numbering stable) |
| `bank/schema.ts` refinement (~185–222) | **new rejection arm**: `language: "shell"` is rejected by name on `write`, `fix`, and `predict-output` — same shape and same error style as the sql-rejects. `cloze` (concrete `Language`) and `recall` (`Language \| "any"`) accept it with no change. Harness kinds already pin `java`. Message names the deferral: shell code drills need the execution engine. |
| `cli/setup.test.ts:160, :201` | update the two hardcoded-4-languages assertions (survey §0 blast radius; appending last keeps `"1,3" = python, java` true, but the comments and the out-of-range index move to 6) |
| `cli/readme-claims.test.ts:101–105` + README | `--lang` row recomputed; README moves in the same commit |
| `engine/grader.ts:43–48` | `shell` arm → `solution.sh` (defensive completeness — unreachable until E4c, but the map should never fall through) |
| `engine/session.ts:207–214` | `shell` arm → `#` comment prefix (the scout-flagged `//`-into-bash fallthrough, fixed now while we're here) |
| `cli/index.ts`, `cli/config.ts`, `cli/setup.ts`, `cli/doctor.ts` | free — they interpolate `LANGUAGES` (scout receipts) — verified by test run, no edits expected |
| CLAUDE.md | delete the stale "there is no vitest config file" claim |

**No `engine/select.ts` change.** A shell cloze/recall grades in-process exactly like a java cloze: offerable with no toolchain, invisible to `spawnsJvm`, no new `Toolchains` member, `hiddenByToolchain` untouched. The allowlist, the mix soft-cap, and `--lang shell` all work through the existing `LANGUAGES`-driven paths — which is the entire reason tier-2 content must not be mis-tagged `"any"` (survey §0: 82 masquerading rows would corrupt `--lang` and never pay the dominance penalty).

**Tests for the task:** schema unit tests for the three rejections + a shell recall/cloze that parses; the two setup-test updates; full suite + typecheck green; readme-claims green against the updated README.

## 5. Content design

**Pack identity.** `atrophy-pack-hrt/pack.json` = `{"name": "hrt"}`; `MANIFEST-HRT.md` carries the roster, stamps, gate tables, and build status (E3 conventions). Ids `hrt-<slug>` per the survey's proposals.

**Roster source.** The survey §2 enumeration IS the candidate list (280 rows, already topic-deduplicated). T2 rosters from it — never from the corpus files directly — applying the binding rulings below, and may re-tier or re-kind a row with a named reason. Authoring work is assigned by **topic wave, never by corpus file** (survey §4.5: the same material appears up to four times across files; the enumeration already resolved that).

**Binding content laws** (traveling law = E2/E3 binding rules verbatim, plus):

1. **Execution-derivation gate** (E4's analog of E3's transcription gate; survey §4.1 is the evidence — three of ten "Expected Output" blocks are arithmetically wrong, verified by execution). Every numeric expectation in a python `fix`/`write`/`predict-output` drill is generated by *executing* the reference solution, never transcribed from the doc. The wave report records each executed-vs-doc divergence found (S1's $200 transposition, S2's self-contradiction, S3's sign error are known; more may surface). A drill whose doc-lifted and executed values differ ships the executed value, with the divergence tabled in the manifest.
2. **S6/S10 are not `fix` drills** (survey §4.2: hints contradict solutions; both are no-bug trick scenarios). They become `predict-output` rows; their hint blocks are ignored entirely.
3. **Stdlib-only** (survey §4.3): candidate 12's order book is rewritten around a plain dict + `sorted()` (or `heapq` with lazy deletion) before authoring; no third-party imports anywhere — the grader's subprocess has no site-packages guarantee.
4. **`06` Section 8 is out of scope** (survey §4.4: prompts with no keys; six are paywalled titles). Algorithmic python content sources only from `04`/`05` where solutions exist.
5. **Dedup rulings** (survey §3): the four direct collisions are re-angled or cut by T2, row by row — 149 re-asks *why* `kill -9` cannot touch a D-state process (not which letter), 237 re-asks the `35=8`+`150=1` partial-fill combination (not `35=D`), 150 and 181 are cut unless T2 finds a distinguishably different fact to pin. Same-concept-different-language rows (13, 15, 11, 191, 224, 62) are kept **with the language framing explicit in the prompt** ("in CPython…", "in Python's FIX router…"). The three probability collisions are already dropped from the enumeration.
6. **api-memory cap**: ≤ 35% of the final roster (survey: 42% over-representation). T2 converts the excess to cloze where a crisp blank exists, cuts the rest.
7. **List-growth framing** (survey §4.6): candidate 59 pins a CPython version and asks the formula or a specific capacity transition, never the headline growth factor.
8. **`09` Part 1 mining rule** (survey §4.7): technical passages only (amortized derivation, data-structure table, production-quality patterns); every factual assertion about the firm is out of scope.
9. **Claim-verification gate, no-epsilon exactness, determinism, leak discipline, output-cap conventions** — verbatim from the E2/E3 traveling law. Rubric bullets are DISPLAYED (engine/session.ts:540); outline rubrics must not leak sibling recall answers.
10. **Answer-key honesty** (survey §6): sql fixtures are authored from scratch (the corpus gives queries only — no DDL, no expected rows); `04` Module 9 S7 and Module 2 fixed-code must be derived, not lifted; `06` §9 items 11–12 stay excluded (no worked answers).

**Wave sketch** (plan finalizes; T2's roster binds): W1 python graded-code (fix 11 + write 12 + predict-output 14ish — the execution-derivation-gate wave); W2 python cloze/recall + probability + amortized (36ish); W3 shell knowledge part 1 (§2f rows 105–152ish); W4 shell knowledge part 2 + shell-tagged networking (§2f rest + §2g L-rows); W5 `any` networking + kernel/HFT (§2g `any` + §2h); W6 trading-domain + sql + outline (§2j + §2i + §2l). Waves are worktree-isolated, each stamps only its own manifest rows, gates from its own scratch DB with `ATROPHY_NO_SYNC=1`.

**Gates.** Pack-only integrity from the `feat/shell-language` checkout (`ATROPHY_BANK=<pack>`); merged doctor with **all four packs** on `ATROPHY_PACKS` — expected count = 639 + final roster size, zero collisions, track `hrt` listed (survey §3's structural note: only merged doctor catches cross-pack id collisions). CLI re-grades through `npx tsx cli/index.ts drill --exercise <id> --solution <file>`.

## 6. Quota and scheduling (binding)

Spec+plan: now (this block). T1 widening + T2 roster: this week, **after the user reviews this spec** — both are small. Content waves W1–W6 + final: **start at the Aug 25 weekly reset** — E4 ≈ 2.5× E2's volume and the remaining ~36% of this boosted week cannot carry it; the Aug 25–31 window is a full boosted week before the promo ends. Waves obey the fan-out protocol (ccusage ×1.6, >50% raw = no wave dispatches, big waves early in fresh blocks, ≤3 concurrent).

## 7. Success criteria

- `"shell"` is a real `Language`: `--lang shell`, the setup menu, the allowlist, and the mix soft-cap all treat it as concrete; graded-code kinds reject it at parse with a named error; full suite + typecheck green on `feat/shell-language`.
- `atrophy-pack-hrt` ships ~200–215 drills, all gates green, zero privacy hits at every review layer, merged doctor clean across four packs, and the manifest carries the roster bijection, stamps, the execution-derivation divergence table, and build status.
- The 35 tier-E candidates and the shell engine remain cleanly deferred: nothing in the shipped pack presupposes execution.

## 8. Expansion-4c parking lot (not binding — the follow-on spec re-decides with these as priors)

Design B (Node-orchestrated per-case runs, comparison in TS) is the shortlisted execution shape. Provisional rulings on the scout's 10 questions: (1) bash floor 4.0, below-floor hosts hide shell-exec drills via `hiddenByToolchain` — never an install demand; (2) WSL actively avoided — never resolve bare `bash` on win32; `ATROPHY_BASH` is a verbatim override the user may point anywhere, divergences documented; (3) shell `fix` out of v1; (4) shell `predict-output` out of v1 (coreutils divergence — and the actual tier-E content is 100% `write`); (5) `cases` shape with the sql anti-hardcoding twin (≥2 cases, different expected stdout, echo-of-literal cheese gate); (6) stdout + exit code only, no `expectedFiles`; (7) `hiddenByToolchain` returns the honest `{jdk, bash}` breakdown; (8) runner untouched — fixtures may not background (`&`/`disown` rejected by the integrity gate), the pathological-user-answer orphan is documented and bounded; (9) CI: verify Git-for-Windows presence on `windows-latest` in a real run before relying on it; no macOS leg, macOS hides shell-exec content; (10) sandbox posture unchanged with a louder doc note. Plus the scout's §4 determinism pins (CR-strip the submitted script, `LC_ALL=C`, `TZ=UTC` with `%Z` banned, `MSYS_NO_PATHCONV`, PATH pinned to `dirname(bash)`, the P2 command-not-found signature = `harnessError` never a score, declared tool allowlist, double-run determinism gate, visible truncation).
