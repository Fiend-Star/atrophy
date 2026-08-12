# Java Language Support — Design

**Date:** 2026-08-13
**Status:** Approved (user sign-off after software-engineer design review, 17 findings folded in)
**Scope:** atrophy engine + built-in bank (upstreamable), plus a private D.E. Shaw exercise pack in `Java-OAs` (out of repo)

## 1. Goal

Add Java as a full first-class exercise language: grading harness, generator families, static bank content, doctor/CI support — at parity with Python/JavaScript. Simultaneously extend the exercise model where the target content demands it (behavioral concurrency drills, short-answer recall, whiteboard mode) and add multi-directory bank support so a private pack can merge with the built-in bank.

**Non-goals:** LLM-judged grading, per-language ratings (one Elo per axis stays shared across languages — accepted), spaced-repetition scheduling (doc-09-style rotations noted for the roadmap), blocking AI tools.

## 2. Schema (`bank/schema.ts`)

### 2.1 Language

`LANGUAGES = ["python", "javascript", "java"]`. Java code exercises use `Solution.java` with `public class Solution` in the default package (no `package` statement). Comment prefix `//` (already handled).

### 2.2 New kinds (discriminated-union members, NOT optional-field refinements)

Zod v4 forbids duplicate discriminator values, and optional-everything types would break static guarantees at every call site (review finding #1). Harness-graded exercises therefore get their own kinds:

- **`write-harness`** / **`fix-harness`** — like `write`/`fix` but graded by an exercise-supplied Java test class instead of JSON tests:
  - `testCode: string` — a complete `public class Harness` with `main`, which must print exactly one `ATROPHY_RESULT {json}` line (contract identical to generated harnesses).
  - `totalChecks: number` (int ≥ 1) — declared check count. Replaces `tests`/`functionName` (absent on these kinds).
  - Java-only in this change (zod enforces `language: "java"`).
- **`recall`** — short-answer concept/puzzle recall, no runnable snippet:
  - Base fields only plus `acceptedAnswers: string[]` (≥ 1) and optional `reveal: string` (derivation shown after grading, ungraded). The base `prompt` field IS the question — no separate field.
  - `language: "any"`. Grading is numeric-tolerant answer match (§3.4).
- Existing kinds unchanged; `predict-output` and `cloze` gain `"java"` as a legal language value only.

### 2.3 Whiteboard mode

Optional `submitPolicy: "loop" | "single"` (default `"loop"`) on `write`, `fix`, `write-harness`, `fix-harness`. `"single"` grades exactly once: no fix-and-resubmit loop, no unchanged-file warning loop beyond the first save check. Session records it like any drill; the score is first-pass truth.

### 2.4 Conventions (documented, enforced by integrity tests, not schema)

- Java `predict-output` snippets: first top-level class named `Main` (run via single-file source launcher; the launcher runs the first class regardless of name — convention only, no grep check).
- Java starters MUST compile: bodies `throw new UnsupportedOperationException("implement me");` (Java has no `pass`; a non-compiling starter would violate the "starter must load" integrity invariant and greet users with raw javac output).
- Stateful/LLD exercises use the ops-driver convention: `functionName(ops, args) → per-op results` with plain JSON tests.
- Exception-expecting predict-output drills wrap the body in try/catch and print `e.getClass().getSimpleName()`.

### 2.5 `totalUnits`

`write-harness`/`fix-harness` → `totalChecks`; `recall` → 1.

## 3. Grading engine

### 3.1 Java toolchain

- **JDK floor: 21** (matches CI; JEP 400 UTF-8 defaults landed in 18 — a 17 floor mis-decodes UTF-8 sources as Cp1252 on Windows; review finding #4). `javac -encoding UTF-8` passed explicitly regardless.
- Discovery: `ATROPHY_JAVA_HOME` (resolve `bin/java(.exe)`, `bin/javac(.exe)` on win32) else PATH. Missing JDK → friendly guidance ("install a JDK ≥ 21 or set ATROPHY_JAVA_HOME"), never a raw spawn error. Note in docs: `.cmd` shims (scoop/mise) need `ATROPHY_JAVA_HOME`.
- Every `java` invocation pins: `-Dfile.encoding=UTF-8 -Duser.language=en -Duser.country=US -Duser.timezone=UTC` (locale/timezone nondeterminism; review finding #5).
- Runner env on win32 additionally passes `TEMP`/`TMP` through (JVM temp-dir resolution falls back to unwritable `C:\Windows` otherwise; review finding #7).
- Timeouts: compile step gets `JAVA_COMPILE_TIMEOUT_MS = 30_000` (compile time is not the user's fault); run step gets the exercise's `testTimeoutMs`. Authoring guidance: `testTimeoutMs` ≥ 20s for Java, ≥ 30s for tier-3 concurrency.

### 3.2 JSON-tests path (`write`/`fix`, language java)

Two real Java resource files live at `engine/java/` (shipped via package.json `files`; resolved with an `existsSync` candidates array — dev `engine/java` vs built `dist/engine/../../engine/java`; grader.ts grows ESM `__dirname` machinery; a test covers the simulated packed layout):

- **`Harness.java`** (~250–300 lines, written once, reviewed as real Java): embedded minimal JSON parser/serializer + reflection. Reads `tests.json` (written per-exercise: `{functionName, tests}`) from the scratch dir; loads `Solution`; finds the method by name+arity (static, or instance via no-arg ctor); coerces args to declared parameter types; invokes; canonicalizes; compares; prints `ATROPHY_RESULT {"passed", "total", "failures": [{index, args, expected, actual?, error?}]}`.
- Flow: write `Solution.java` + `Harness.java` + `tests.json` → `javac -encoding UTF-8 Solution.java Harness.java` → `java <pinned flags> Harness` → parse last marker line. javac stderr becomes `harnessError` ("Your code did not run" path). Class-load failure emits friendly guidance ("keep `class Solution`, default package").

**Number model (review finding #2):** parse integer literals fitting `long` as `Long`, else `Double`. Serializer: `Long` as integer; finite integral `Double` with |v| ≤ 2^53 as integer string; `NaN`/`Infinity` as `null` (matches `JSON.stringify`). So `2.0` equals `2`, both directions.

**Supported-type matrix (review finding #10)** — every row a coercion-matrix test; everything outside it a *named* harness error:
- Params/returns: `int long double boolean String`, `int[] long[] double[] boolean[] String[]`, `List<T>` (element-coerced via `getGenericParameterTypes()` — `List<Integer>` gets `Integer`, not `Double`), `Map<String, T>`, `Object` (raw parsed value).
- `char`: accepted as 1-character string. `null` into a primitive: named error. Overloads: >1 name+arity candidate → "overloads not supported". Varargs, `BigDecimal`/`BigInteger`: named error (v1).
- Returns: primitive arrays via `java.lang.reflect.Array`; collections serialize in iteration order (prompts must demand `List` returns — a correct-but-`HashSet` answer fails; stated in authoring docs); non-String map keys stringified (Python parity); serializer depth guard (~64) → per-test error, not a harness-killing `StackOverflowError`.

### 3.3 testCode path (`write-harness`/`fix-harness`)

- Scratch dir gets `Solution.java`, `Harness.java` (= `testCode` verbatim — what's in the JSON is what runs), and **`Atrophy.java`** (~30-line optional helper: `Atrophy.check(String name, boolean ok)`, `Atrophy.report()`; collects and prints the marker). Compile all three, run `Harness`.
- Failure shape (review finding #8): `{index: i, error: "<check name>: <message>"}` — no fake args/expected. `printFailures` learns to render arg-less entries by their error text.
- **Grade-time enforcement (review finding #3):** harness-reported `total !== totalChecks` ⇒ `harnessError` ("exercise bug — report this exercise"); the rating never moves on garbage. `exerciseScore` clamps `passed/total` to [0,1] as defense in depth.
- **Determinism duties (review finding #6):** starter bugs must fail deterministically (throw, or bounded latch-based detection with generous awaits — never a sleep race); harnesses run an internal watchdog printing partial `ATROPHY_RESULT` before the external timeout so deadlock scores 0 with named failures; ≤ 4 threads; internal deadlines ≥ 5s.
- testCode may read `Solution.java` from the scratch dir for static-source assertions (e.g. "field must be `volatile`") — how memory-model drills whose bugs are invisible on x86 get graded.

### 3.4 recall grading

Pure in-process (no subprocess). Normalization before comparison: trim/casefold; parse numeric forms — fractions (`1/4`), decimals (`0.25`), percents (`25%`) — to a canonical rational where possible, epsilon 1e-9 for floats; non-numeric answers compare as normalized strings against `acceptedAnswers`. After grading, print `reveal` (the derivation) if present. Session flow mirrors cloze (one readline question; `q` abandons).

### 3.5 predict-output, java

Snippet written to `Main.java`, run via source launcher (`java <pinned flags> Main.java`) — single file, no separate compile step. Ground truth computed by running the snippet (existing mechanism).

## 4. Multi-directory banks (packs)

- `loadBank(dirs: string | string[])` merges; duplicate id across any dirs → `BankError` naming both files.
- Base bank: unchanged semantics (`ATROPHY_BANK` still full-replace). Additive packs: `ATROPHY_PACKS` (delimited by `path.delimiter`) + `"packs": string[]` in `~/.atrophy/config.json`. Config read shared with publish.ts (extract `cli/config.ts`).
- `doctor` lists each pack dir with exercise count and runs schema validation on it; docs state packs execute code — only add trusted dirs.
- The private pack lives at `C:\Users\gurms\IdeaProjects\Java-OAs\atrophy-pack\exercises\` (manifest + source inventories already at `Java-OAs\atrophy-pack\`).

## 5. Generators

Four Java families under the existing determinism contract (`generate(seed, tier)` reproducible, ids `family-<6hex>`):
- `sr-java-*` (write): string/array/collection manipulation variants.
- `dbg-java-*` (fix): planted bugs — off-by-one, boundary, mutate-vs-copy, `==` vs `.equals()`.
- `cr-java-*` (predict-output): deterministic constructs only — `LinkedHashMap`/`TreeMap`, no `HashMap` order, no threads, no locale-sensitive formatting, no default `toString`.
- `api-java-*` (cloze): `java.util`/`Collections`/`String`/streams blanks.

Generator tests: schema validity + determinism per family × tier, plus real-grading spot checks (sampled `dbg-java` starter fails; sampled `cr-java` runs deterministically; sampled `sr-java` reference solution passes).

## 6. CLI / doctor / CI

- `--lang` validated against `LANGUAGES` (currently unvalidated cast); help strings updated; `baseline -l <lang>` filters axes by exercises available in that language (pre-existing bug: aborts on first axis with no matching content).
- `doctor`: `checkJava` mirroring `checkPython` (presence, version ≥ 21, `ATROPHY_JAVA_HOME` echo), pack listing/validation.
- CI: `actions/setup-java` (Temurin 21) on both OSes. Bank-integrity Java suites get their own `describe` with ~300s budgets. When no JDK locally: **loud** skip ("Java exercises NOT validated — install JDK 21"); integrity loops filter per-language so a JDK-less contributor still validates py/js.
- README (language table, install note, packs, recall/whiteboard) and CLAUDE.md (new invariants: kinds, JDK floor, packs, dual-path for `engine/java`) updated.

## 7. Testing

- Schema: new kinds' shapes, `totalChecks` bounds, java-only enforcement for harness kinds, `submitPolicy`, recall fields; multi-dir `loadBank` + duplicate-id error; packs resolution (env + config + both).
- Grader integration (JDK-gated, loud skip): compile error / runtime exception / timeout / pass / partial; the full coercion+number matrix of §3.2; static vs instance; testCode pass/fail with and without `Atrophy` helper; totalChecks mismatch ⇒ harnessError; watchdog/deadlock ⇒ 0 with named failures; predict-output java; recall normalization table (fractions/percent/decimal/string; epsilon).
- Bank integrity (extended): existing invariants apply to Java automatically; ALL Java starters must compile; `fix-harness` starters must fail deterministically with reported total == `totalChecks`; packed-layout resource-resolution test.
- Manual verification: `atrophy drill --lang java` (each kind), `--show`, `--solution`, whiteboard drill, pack merge via config.

## 8. Content plan

Manifest: `Java-OAs\atrophy-pack\DRILL-MANIFEST.md` (708 entries: 680 shippable across waves 1–3, 28 blocked in wave X; per-entry axis/kind/grading/tier/soft-limit/source/flags; dedupe log; authoring-risk appendix). Source inventories in `Java-OAs\atrophy-pack\sources\`.

- **Built-in bank (upstream):** 4–6 static Java exercises per axis across write/fix/predict-output/cloze (matching existing per-axis py/js coverage), plus 3–4 genericized tier-3 `write-harness` concurrency drills (write-preferring RW lock, bounded blocking queue, striped counter) — no company references.
- **Private pack waves:** wave 1 (58: deterministic first slices — the ten-exercise concurrency slice, ten objective LLD write drills, doc-09 drill bodies with Tier-A DSA, high-value predict-output set) → wave 2 (295: all remaining planned) → wave 3 (327: derived).
- **Wave X resolution (final phase, all 28):** SQL problems (11) get graded in-process via the existing `better-sqlite3` dependency — this needs a small dedicated exercise kind (schema + grader) whose design is deliberately deferred to this phase as its own mini-spec (MySQL→SQLite dialect notes recorded per exercise in the manifest); answer-less puzzles (6) get authored canonical answers as `recall`; HashMap-order snippet converted to a `LinkedHashMap` variant; conceptual tree ops → `outline` rubrics; editorial-cleanup items rewritten.
- **Authoring guards:** the seven source-doc defects (Drill01 writer count + missing `finally`, non-compiling deadlock snippet, seat-release outside `finally`, `CountDownLatch` name shadowing, impossible O(1) `getKthMin`, undefined `wouldLeaveKingInCheck`) are fixed at authoring time — reference solutions never inherit them. Ten drills get injected clocks. Three cross-doc factual conflicts resolved to one canonical answer key in the pack.

## 9. Accepted limitations (stated, not fixed)

- One Elo per axis shared across languages; tier-3 `write-harness` drills may play like "tier 3.5" against the fixed 1400 opponent.
- The `ATROPHY_RESULT` marker is forgeable via shutdown hooks — exact parity with Python `atexit`/Node `exit` today; honor-system product; a nonce would close it for all three languages if ever needed.
- Harness/tests are readable in the scratch dir after first submit — parity with existing languages.
- Whiteboard mode can't stop a user compiling in their own terminal; it removes the tool's feedback loop, not the OS.

## 10. References

- Design review: software-engineer agent, 17 ranked findings (session artifact; key items inlined above as "review finding #N").
- Corpus: 4 reader inventories over ~19k lines of DeShaw material → `Java-OAs\atrophy-pack\sources\inventory-{core,dsa,concurrency,design}.md`.
- PLAN.md §3.3/§3.4 (difficulty/scoring contracts unchanged).
