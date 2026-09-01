# Java Content Plan B — Generators, Built-in Bank, DeShaw Pack Wave 1

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Amended during execution — the SDD ledger's rulings supersede this text where they differ.** Notably: the "catch-all check slot" in the harness tasks (9, 14, 16) is ABOLISHED — `Atrophy.plan(N)`/`totalChecks` count behavioral+scan checks only (the `catch (Throwable)` block still reports a named failing check on crash; `report()` pads); no harness check may be satisfiable by default `Object` behavior with zero user code; worker-side holds must strictly exceed every main-side proof deadline. Untouched write-harness starters must grade 0/N. See `.superpowers/sdd/2026-08-13-java-content-plan-b/progress.md`.

**Goal:** Ship the first Java content wave: four generator families, ~21 built-in bank exercises, and the 58-exercise DeShaw pack wave 1 — all passing the bank-integrity gate.

**Architecture:** Content flows through the existing pipeline unchanged: exercise JSON (static) or `ExerciseGenerator` (families) → `loadBank`/`allGenerators` → `selectExercise` → the Java grading engine shipped in Plan A. Two small engine changes lead the plan (generator-language visibility in axis selection; integrity timeout lints); everything after is pure content, gated by `bank/bank-integrity.test.ts`.

**Tech Stack:** TypeScript (ESM NodeNext, strict, `noUncheckedIndexedAccess`), zod schema in `bank/schema.ts`, vitest, Java 21 (javac/java via `engine/javatool.ts`), mulberry32 RNG.

**Spec:** `docs/superpowers/specs/2026-08-13-java-language-support-design.md` (§5 generators, §8 content plan; §2.4 authoring conventions; §3.3 harness determinism duties). Manifest: `C:\Users\gurms\IdeaProjects\Java-OAs\atrophy-pack\DRILL-MANIFEST.md` §2 (wave 1, 58 entries — implementers of Tasks 10–16 MUST read their section's manifest rows; the notes column is part of the requirement).

## Global Constraints

Copied from the spec, CLAUDE.md, and the Plan A final review — every task's requirements implicitly include these:

- **Two repos.** Tasks 1–9 and 17 commit in `C:\Users\gurms\IdeaProjects\atrophy` (branch `feat/java-language-support`). Tasks 10–16 create files in `C:\Users\gurms\IdeaProjects\Java-OAs\atrophy-pack\exercises\` and commit in the `Java-OAs` repo. Never mix: a task commits only in its own repo.
- **ESM imports:** relative imports use `.js` extensions inside `.ts` files.
- **Java starters must compile** (integrity runs `javac` on every one, exit 0). Method bodies: `throw new UnsupportedOperationException("implement me");`. `public class Solution`, **no `package` line**, graded method package-private or public, never private, unique by arity (no overloads).
- **`fix`/`fix-harness` planted bugs are semantic** (wrong bound, missed lock, lost update) — never a syntax or type error (the starter still compiles).
- **Harness kinds** (`write-harness`/`fix-harness`): `testCode` is a complete `public class Harness` with `main` printing exactly one `ATROPHY_RESULT` line; reported total must equal `totalChecks`. Every harness wraps its checks:

  ```java
  public class Harness {
      public static void main(String[] args) {
          Atrophy.plan(N);            // N == totalChecks
          Atrophy.watchdog(WATCHDOG_MS); // well under testTimeoutMs
          try {
              /* checks: Atrophy.check("name", condition); */
          } catch (Throwable t) {
              Atrophy.check("harness crashed: " + t, false);
          } finally {
              Atrophy.report();
          }
      }
  }
  ```

  A harness must **always report**, including on the buggy starter it ships with (integrity grades every harness starter and requires a real result, not a `harnessError`).
- **Harness starters compile STANDALONE** (Plan A final review L170): integrity compiles `starterCode` alone, so a starter may not reference types declared only in `testCode`.
- **Harness determinism duties** (spec §3.3): starter bugs fail deterministically (throw, or bounded latch-based detection with generous awaits — never a sleep race); ≤ 4 threads unless the drill's whole point needs more (8 is the ceiling used by the manifest's counting drills); internal deadlines ≥ 5s; `Atrophy.watchdog(ms)` always armed and well under `testTimeoutMs`.
- **Timeouts** (enforced by Task 2's lint): every Java exercise that spawns a JVM (`write`, `fix`, `write-harness`, `fix-harness`, `predict-output`) sets `testTimeoutMs >= 20_000`; tier-3 harness kinds `>= 30_000`. This plan's conventions: predict-output 20_000; write/fix 20_000; fix-harness 30_000 (watchdog 15_000); heavy write-harness builders 45_000 (watchdog 30_000).
- **Java `predict-output` snippets:** first top-level class named `Main`; deterministic constructs only — `LinkedHashMap`/`TreeMap` (never `HashMap` iteration), no threads, no locale-sensitive formatting, no default `toString`, no `now()`/randomness. Exception-expecting snippets wrap the body in try/catch and print `e.getClass().getSimpleName()` — **that is the spec §2.4 resolution; there is NO exception-expectation schema field** (the manifest notes that say otherwise are superseded).
- **Collection-returning prompts must demand `List` returns** (a correct-but-`HashSet` answer fails; spec §3.2). `Map` parameters declare a literal `String` key type. Integer test values stay within ±2^53.
- **Injected clock rule:** no exercise may depend on wall-clock time — time-dependent inputs (e.g. `SendingTime` in `fix-message-checksum`) are arguments, never `now()`.
- **Ids:** static bank ids follow the folder prefix scheme (`sr-java-NNN`, `dbg-java-NNN`, `cr-java-NNN`, `api-java-NNN`, `dec-java-NNN`); pack ids are the manifest slugs verbatim (they match the id regex `^[a-z][a-z0-9]*(-[a-z0-9]+)+$`). Generated ids are `family-<seed>` — the family strings registered in Tasks 3–6 must not collide with any static id prefix.
- **Determinism contract for generators:** `generate(seed, tier)` returns an identical exercise for identical inputs; all randomness through `rngFor(family, seed, tier)`; never `Date.now()`/`Math.random()`.
- **Recording safety:** ANY command that records a session runs with `$env:ATROPHY_NO_SYNC="1"` and `$env:ATROPHY_DB` pointed at a throwaway file. `--show` and `--solution` previews of grading still record when they complete — always set both env vars for spot-grades.
- **Gate commands** (run from the atrophy repo, PowerShell):
  - Base integrity: `npx vitest run bank/bank-integrity.test.ts`
  - Pack integrity (replaces the bank — validates the pack alone): `$env:ATROPHY_BANK="C:\Users\gurms\IdeaProjects\Java-OAs\atrophy-pack\exercises"; npx vitest run bank/bank-integrity.test.ts; Remove-Item Env:ATROPHY_BANK`
  - Merged id-collision + env check: `$env:ATROPHY_PACKS="C:\Users\gurms\IdeaProjects\Java-OAs\atrophy-pack\exercises"; npx tsx cli/index.ts doctor; Remove-Item Env:ATROPHY_PACKS`
  - Spot-grade a reference solution: `$env:ATROPHY_NO_SYNC="1"; $env:ATROPHY_DB="$env:TEMP\atrophy-plan-b.db"; npx tsx cli/index.ts drill --exercise <id> --solution <file>` (add `$env:ATROPHY_BANK=<pack dir>` for pack exercises; `npm run dev --` swallows flags — always `npx tsx cli/index.ts`).
- **Full suite + typecheck before every commit in the atrophy repo:** `npm test` and `npm run typecheck`. Pack-repo commits need the pack integrity gate green instead.

---

### Task 1: Generator languages visible to axis selection

The Plan A final review flagged (L158): `availableAxes` scans only static exercises, so an axis whose only Java content is a generator family is invisible to `--lang java` axis picking, and `dueAxis` will never select it. Fix before any Java generator lands.

**Files:**
- Modify: `engine/select.ts:128-135` (`availableAxes`)
- Modify: `cli/index.ts:84-85` (`dueAxis`), `cli/index.ts:319` (`axesWithExercises`)
- Test: `engine/select.test.ts`

**Interfaces:**
- Consumes: `ExerciseGenerator` from `bank/generators/types.js` (already imported by select.ts), `allGenerators` from `bank/generators/index.js` (cli side).
- Produces: `availableAxes(bank: Exercise[], language?: Language, generators: ExerciseGenerator[] = []): Axis[]` — third parameter, default `[]` so every existing call keeps compiling and behaving identically.

- [ ] **Step 1: Write the failing test** in `engine/select.test.ts`:

```ts
describe("availableAxes with generators", () => {
  const javaGen: ExerciseGenerator = {
    family: "sr-java-test",
    axis: "syntax-recall",
    language: "java",
    tiers: [1],
    generate() {
      throw new Error("never called by availableAxes");
    },
  };

  it("includes an axis whose only content for the language is a generator family", () => {
    expect(availableAxes([], "java", [javaGen])).toEqual(["syntax-recall"]);
  });

  it("still excludes axes with no static or generator content", () => {
    expect(availableAxes([], "java", [])).toEqual([]);
  });

  it("does not add axes for a non-matching language filter", () => {
    expect(availableAxes([], "python", [javaGen])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run engine/select.test.ts -t "availableAxes with generators"`
Expected: FAIL — `availableAxes` accepts only two arguments / returns `[]` for the first case.

- [ ] **Step 3: Implement** — replace `availableAxes` in `engine/select.ts`:

```ts
/** Axes that actually have content for the given language ("any" counts for every language). */
export function availableAxes(
  bank: Exercise[],
  language?: Language,
  generators: ExerciseGenerator[] = [],
): Axis[] {
  const matchesLang = (l: Language | "any") =>
    language === undefined || l === language || l === "any";
  return AXES.filter(
    (axis) =>
      bank.some((e) => e.axis === axis && matchesLang(e.language)) ||
      generators.some((g) => g.axis === axis && matchesLang(g.language)),
  );
}
```

In `cli/index.ts`, thread `allGenerators` (already imported for `selectExercise`) into both call sites: `availableAxes(bank, language, allGenerators)` at line 85 (inside `dueAxis`) and line 319.

- [ ] **Step 4: Run the focused test, then the suite**

Run: `npx vitest run engine/select.test.ts` → PASS; `npm test` → all green; `npm run typecheck` → clean.

- [ ] **Step 5: Commit** (atrophy repo)

```powershell
git add engine/select.ts engine/select.test.ts cli/index.ts
git commit -m "fix(select): axis availability sees generator families, not just static content"
```

---

### Task 2: Integrity lints for Java content timeouts

JVM cold start makes the schema's 10s default `testTimeoutMs` a flake factory for Java. Enforce the spec §3.1 guidance mechanically before content lands.

**Files:**
- Modify: `bank/bank-integrity.test.ts` (inside the existing per-language structure; this lint is NOT JDK-gated — it reads JSON, spawns nothing)
- Test: same file (the lint IS the test)

**Interfaces:**
- Consumes: the loaded bank array the suite already builds; `isHarness` from `bank/schema.js`.
- Produces: nothing for later tasks — but every Java exercise authored in Tasks 3–16 must satisfy it.

- [ ] **Step 1: Write the lint** (add near the other whole-bank invariants, outside any `skipIf(!hasJdk())` gate):

```ts
const JVM_KINDS = new Set(["write", "fix", "write-harness", "fix-harness", "predict-output"]);

describe("java timeout floors", () => {
  const javaJvm = bank.filter(
    (ex) => "language" in ex && ex.language === "java" && JVM_KINDS.has(ex.kind),
  );

  it("every JVM-spawning java exercise allows at least 20s", () => {
    const bad = javaJvm.filter((ex) => ex.testTimeoutMs < 20_000);
    expect(bad.map((ex) => `${ex.id}: ${ex.testTimeoutMs}`)).toEqual([]);
  });

  it("tier-3 harness drills allow at least 30s", () => {
    const bad = javaJvm.filter(
      (ex) => isHarness(ex) && ex.tier === 3 && ex.testTimeoutMs < 30_000,
    );
    expect(bad.map((ex) => `${ex.id}: ${ex.testTimeoutMs}`)).toEqual([]);
  });
});
```

- [ ] **Step 2: Prove the lint bites** — temporarily drop a java write exercise with `testTimeoutMs: 5000` into `bank/exercises/syntax-recall/`, run `npx vitest run bank/bank-integrity.test.ts`, watch the new lint fail naming the id, then delete the file. (The base bank has no Java exercises yet, so without this probe the lint passes vacuously — the probe is the RED step.)

- [ ] **Step 3: Extend the generator determinism loop** — where the suite iterates `allGenerators` sampling each family × tier, add the same floor for generated java exercises:

```ts
if ("language" in sample && sample.language === "java" && JVM_KINDS.has(sample.kind)) {
  expect(sample.testTimeoutMs, `${gen.family} tier ${tier}`).toBeGreaterThanOrEqual(20_000);
}
```

- [ ] **Step 4: Full suite + typecheck**

Run: `npm test` → green (lint vacuous until Task 3 lands content — that is expected and fine, the probe in Step 2 proved non-vacuity); `npm run typecheck` → clean.

- [ ] **Step 5: Commit** (atrophy repo)

```powershell
git add bank/bank-integrity.test.ts
git commit -m "test(bank): timeout floors for java content (20s JVM, 30s tier-3 harness)"
```

---

### Task 3: `sr-java-cond` generator family

Extend the existing cond-family builder to Java. Java naming matches the JS branch (camelCase); the starter is a compiling `Solution` class; tests are identical computed vectors.

**Files:**
- Modify: `bank/generators/syntax-recall.ts` (extend `makeCondGenerator`, register `sr-java-cond`)
- Test: `bank/generators/generators.test.ts` (the existing per-family determinism/validity loops pick the new family up automatically from `allGenerators` — add the java-specific rows below)

**Interfaces:**
- Consumes: `ExerciseGenerator`, `rngFor`, `SOFT_LIMIT_BY_TIER` from `./types.js`; the existing `PREDICATES`/`reference` machinery.
- Produces: family `"sr-java-cond"` in `syntaxRecallGenerators` (flows into `allGenerators`); generated kind `write`, `language: "java"`, tiers `[1, 2]`, `functionName` identical to the JS naming (`sumEvens`, `countOver3`, …).

- [ ] **Step 1: Widen the builder signature** — `makeCondGenerator(family: string, language: "python" | "javascript" | "java")`. Java shares the JS `fnName` branch (`${agg}${pred.jsName(k)}`). Add the starter branch and, for java only, `testTimeoutMs: 20_000` in the raw object:

```ts
const starterCode =
  language === "python"
    ? `def ${fnName}(nums):\n    pass\n`
    : language === "javascript"
      ? `function ${fnName}(nums) {\n  // your code\n}\n\nmodule.exports = { ${fnName} };\n`
      : `public class Solution {\n    static int ${fnName}(int[] nums) {\n        throw new UnsupportedOperationException("implement me");\n    }\n}\n`;
```

(`int[]` param + `int` return sit squarely in the Plan A coercion matrix; the computed `expected` values are always integers.)

- [ ] **Step 2: Register the family**

```ts
export const syntaxRecallGenerators: ExerciseGenerator[] = [
  makeCondGenerator("sr-py-cond", "python"),
  makeCondGenerator("sr-js-cond", "javascript"),
  makeCondGenerator("sr-java-cond", "java"),
];
```

- [ ] **Step 3: Add java-specific test rows** in `generators.test.ts`:

```ts
it("sr-java-cond renders a compiling-shape java starter with a matching functionName", () => {
  const gen = allGenerators.find((g) => g.family === "sr-java-cond")!;
  const ex = gen.generate("abc123", 1);
  expect(ex.kind).toBe("write");
  expect(ex.language).toBe("java");
  if (ex.kind !== "write") throw new Error("unreachable");
  expect(ex.starterCode).toContain("public class Solution");
  expect(ex.starterCode).not.toContain("package ");
  expect(ex.starterCode).toContain(`static int ${ex.functionName}(int[] nums)`);
  expect(ex.testTimeoutMs).toBeGreaterThanOrEqual(20_000);
});
```

Run: `npx vitest run bank/generators/generators.test.ts` → the new row plus the existing determinism loop (which asserts `generate(seed, tier)` twice-equal for every family × tier) must pass.

- [ ] **Step 4: Real-grading spot check** (JDK present): generate one exercise and grade its reference solution through the CLI:

```powershell
$env:ATROPHY_NO_SYNC="1"; $env:ATROPHY_DB="$env:TEMP\atrophy-plan-b.db"
npx tsx cli/index.ts drill --exercise sr-java-cond-abc123 --tier 1 --show
```

Write the printed spec's reference solution to a scratch `.java` file and grade it with `--solution`; expect Score 1.00. (This is the spec §5 "sampled sr-java reference solution passes" check, done once manually here; the integrity suite's generator sampling covers schema/determinism continuously.)

- [ ] **Step 5: Full suite + typecheck, then commit** (atrophy repo)

```powershell
git add bank/generators/syntax-recall.ts bank/generators/generators.test.ts
git commit -m "feat(generators): sr-java-cond family (java write variants)"
```

---

### Task 4: `dbg-java-scan` generator family

Fix-kind family: small array-scan functions with one planted semantic bug chosen per seed. The reference implementation computes `expected`; the starter ships the bug; integrity's "every fix exercise's bug must fail a test" invariant gates it automatically once the family is registered (the suite samples generated fix exercises the same way — verify that assumption in Step 1 and extend the sampling if it only covers statics).

**Files:**
- Modify: `bank/generators/debugging.ts` (add the family alongside the existing dbg-py/dbg-js builders, following that file's local pattern)
- Test: `bank/generators/generators.test.ts`

**Interfaces:**
- Consumes: `rngFor`, `SOFT_LIMIT_BY_TIER`, `exerciseSchema`.
- Produces: family `"dbg-java-scan"`, kind `fix`, `language: "java"`, tiers `[1, 2]`.

- [ ] **Step 1: Check integrity coverage of generated fix exercises.** Read the fix-bug invariant in `bank/bank-integrity.test.ts`: if it grades only static `fix` exercises, extend it to sample each fix-kind generator family (one seed per tier) under the same JDK-gated describe — a generated fix starter must fail at least one test, exactly like a static one.

- [ ] **Step 2: Implement the family.** Two variant archetypes, picked by rng; both compile, both fail deterministically against computed tests:

```ts
type ScanVariant = "maxOffByOne" | "stringEqRef";

// maxOffByOne: max of nums[0..n-2] — misses the last element.
//   correct: loop i < nums.length      buggy: loop i < nums.length - 1
//   fnName maxOf, tests include a case where the max sits in the LAST slot (guaranteed failure).
// stringEqRef: count occurrences of target in words using == instead of .equals().
//   fnName countMatches(String[] words, String target)
//   Tests pass distinct-but-equal strings; harness JSON-parses fresh String objects, so == is
//   false where .equals() is true — deterministic failure by construction.
```

Starter for `maxOffByOne` (tier 1):

```java
public class Solution {
    static int maxOf(int[] nums) {
        int best = nums[0];
        for (int i = 1; i < nums.length - 1; i++) {
            if (nums[i] > best) best = nums[i];
        }
        return best;
    }
}
```

Starter for `stringEqRef` (tier 2):

```java
public class Solution {
    static int countMatches(String[] words, String target) {
        int count = 0;
        for (String w : words) {
            if (w == target) count++;
        }
        return count;
    }
}
```

Prompts state the intended behavior ("return the maximum of the whole array" / "count elements equal to target by value") and never name the bug. Tests: 4–6 vectors computed from a correct reference in TS, always including the bug-revealing case (max-in-last-slot; at-least-one-match). `testTimeoutMs: 20_000`.

- [ ] **Step 3: Test rows** — determinism is covered by the existing loop; add shape rows mirroring Task 3 (starter contains `public class Solution`, no `package`, `testTimeoutMs >= 20_000`) plus one bug-actually-fails check if Step 1 did not already put generated families under the JDK-gated invariant.

Run: `npx vitest run bank/generators/generators.test.ts` and `npx vitest run bank/bank-integrity.test.ts` → PASS (with JDK present the planted bugs are demonstrated failing).

- [ ] **Step 4: Full suite + typecheck, then commit** (atrophy repo)

```powershell
git add bank/generators/debugging.ts bank/generators/generators.test.ts bank/bank-integrity.test.ts
git commit -m "feat(generators): dbg-java-scan family (planted semantic bugs)"
```

---

### Task 5: `cr-java-trace` generator family

Predict-output family rendering deterministic Java `Main` snippets: seeded int arrays through running aggregates and `TreeMap`/`LinkedHashMap` iteration. Ground truth is computed at grade time by running the snippet — the generator's obligations are determinism of the rendered source and clean execution (integrity runs every predict-output snippet and requires deterministic output across two runs).

**Files:**
- Modify: `bank/generators/code-reading.ts` (add family per that file's local pattern)
- Test: `bank/generators/generators.test.ts`

**Interfaces:**
- Consumes: `rngFor`, `PREDICT_LIMIT_BY_TIER`.
- Produces: family `"cr-java-trace"`, kind `predict-output`, `language: "java"`, tiers `[1, 2]`.

- [ ] **Step 1: Implement.** Tier 1 — running aggregate over a seeded 4–6 element array (sum/max/count of evens, printed once per iteration). Tier 2 — the same array through a `TreeMap<Integer, Integer>` (value → count) printed via `entrySet` iteration (sorted, deterministic), or a `LinkedHashMap` preserving insertion order. Snippet skeleton (tier 1, sum variant):

```java
public class Main {
    public static void main(String[] args) {
        int[] nums = {S1, S2, S3, S4, S5};   // seeded literals
        int acc = 0;
        for (int n : nums) {
            acc += n;
            System.out.println(acc);
        }
    }
}
```

All values are seeded literals baked into the source. Prohibited constructs (spec §5): `HashMap` iteration, threads, locale-sensitive formatting (`printf` with `%f` is allowed only with explicit `Locale.ROOT` — simplest: don't use printf at all), default `toString` of arrays/objects, wall-clock. `testTimeoutMs: 20_000`, `softTimeLimitSeconds` from `PREDICT_LIMIT_BY_TIER`.

- [ ] **Step 2: Test rows** — shape (`class Main`, no `package`, no `HashMap(` substring, `testTimeoutMs >= 20_000`); determinism via the existing loop. Then run the integrity suite — its predict-output invariant (run twice, identical stdout, clean exit) now executes sampled `cr-java-trace` snippets under the JDK gate; if the sampling loop covers only static predicts, extend it to sample predict-kind generator families one seed per tier, same as Task 4 Step 1 did for fix.

Run: `npx vitest run bank/generators/generators.test.ts bank/bank-integrity.test.ts` → PASS.

- [ ] **Step 3: Full suite + typecheck, then commit** (atrophy repo)

```powershell
git add bank/generators/code-reading.ts bank/generators/generators.test.ts bank/bank-integrity.test.ts
git commit -m "feat(generators): cr-java-trace family (deterministic predict-output)"
```

---

### Task 6: `api-java-blank` generator family

Cloze family over `java.util`/`Collections`/`String`/streams idioms. Each variant is a (snippet, blank, acceptedAnswers) triple from a fixed table; the rng picks the variant and the seeded identifiers.

**Files:**
- Modify: `bank/generators/api-memory.ts` (add family per that file's local pattern)
- Test: `bank/generators/generators.test.ts`

**Interfaces:**
- Consumes: `rngFor`, `CLOZE_LIMIT_BY_TIER`.
- Produces: family `"api-java-blank"`, kind `cloze`, `language: "java"`, tiers `[1, 2]`.

- [ ] **Step 1: Implement with this variant table** (tier 1 = first four, tier 2 = last four; every snippet must contain exactly one `____`, integrity enforces presence):

| snippet core | acceptedAnswers |
|---|---|
| `int c = counts.____(key, 0) + 1;` (Map<String,Integer>) | `["getOrDefault"]` |
| `Collections.____(list);` — prompt: "sort ascending" | `["sort"]` |
| `String s = String.____(",", parts);` | `["join"]` |
| `Deque<Integer> st = new ArrayDeque<>(); st.____(x);` — prompt: "stack push" | `["push"]` |
| `list.stream().____(n -> n * 2).toList();` | `["map"]` |
| `list.stream().____(n -> n % 2 == 0).count();` | `["filter"]` |
| `map.____(key, 1, Integer::sum);` — prompt: "count occurrences atomically-ish in one call" | `["merge"]` |
| `Arrays.____(arr, (a, b) -> a[0] - b[0]);` | `["sort"]` |

The prompt names the intended behavior precisely enough that only the listed answers fit (cloze grading is exact-match on the normalized answer string). Cloze spawns no JVM — no timeout floor applies; use the schema default.

- [ ] **Step 2: Test rows** — exactly one `____` in every sampled snippet; `acceptedAnswers.length >= 1`; determinism via the existing loop.

Run: `npx vitest run bank/generators/generators.test.ts bank/bank-integrity.test.ts` → PASS (integrity's cloze invariant checks the `____`).

- [ ] **Step 3: Full suite + typecheck, then commit** (atrophy repo)

```powershell
git add bank/generators/api-memory.ts bank/generators/generators.test.ts
git commit -m "feat(generators): api-java-blank family (java.util/streams cloze)"
```

---

### Task 7: Built-in bank — write and fix statics (10 exercises)

Generic (no company references), one JSON file each, upstream-quality.

**Files (create):**
- `bank/exercises/syntax-recall/sr-java-001.json` — write, tier 1: `reverseWords(String s) -> String` (split on single spaces, reverse word order)
- `bank/exercises/syntax-recall/sr-java-002.json` — write, tier 2: `topFrequent(String[] words, int k) -> List<String>` (frequency desc, then lexicographic; prompt demands a `List` return)
- `bank/exercises/debugging/dbg-java-001.json` — fix, tier 1: binary search with `lo <= hi` written as `lo < hi` (misses single-element window)
- `bank/exercises/debugging/dbg-java-002.json` — fix, tier 1: `==` on `Integer` boxes beyond the cache (works for small tests unless a >127 vector is included — include two)
- `bank/exercises/debugging/dbg-java-003.json` — fix, tier 2: mutate-vs-copy — method sorts the caller's array in place then returns it; spec says return a NEW sorted array leaving the input untouched (tests pass the same array twice and check both results — the reference JSON encodes the unmutated expectation)
- `bank/exercises/debugging/dbg-java-004.json` — fix, tier 2: sublist accumulation reusing one mutable `ArrayList` (every result row shows the last window); fix is a fresh list per row. Prompt demands `List<List<Integer>>` sliding windows
- `bank/exercises/decomposition/dec-java-001.json` — write, tier 1: run-length encode `String -> String` (`"aaabb" -> "a3b2"`, empty stays empty)
- `bank/exercises/decomposition/dec-java-002.json` — write, tier 2: merge overlapping intervals `int[][] -> List<List<Integer>>` (prompt demands List rows, sorted by start)
- `bank/exercises/decomposition/dec-java-003.json` — write, tier 2: group anagrams `String[] -> List<List<String>>` (each group sorted, groups sorted by first element — fully deterministic output)
- `bank/exercises/decomposition/dec-java-004.json` — write, tier 3: `evaluateRPN(String[] tokens) -> int` with integer division truncating toward zero (the trap: `-7/2`)

**Interfaces:**
- Consumes: the Plan A grading pipeline; the schema shapes shown below.
- Produces: static ids `sr-java-001..002`, `dbg-java-001..004`, `dec-java-001..004` (Tasks 8–9 continue these sequences).

- [ ] **Step 1: Author all ten.** Fully worked example establishing the template every file follows (id/tier/prompt/starter/tests as appropriate to its row above):

```json
{
  "id": "dbg-java-001",
  "kind": "fix",
  "axis": "debugging",
  "language": "java",
  "tier": 1,
  "title": "Binary search misses the last window",
  "prompt": "indexOf(int[] sorted, int target) must return the index of target in the ascending array, or -1 if absent. One of these tests fails. Find the bug and fix it without rewriting the algorithm.",
  "functionName": "indexOf",
  "starterCode": "public class Solution {\n    static int indexOf(int[] sorted, int target) {\n        int lo = 0, hi = sorted.length - 1;\n        while (lo < hi) {\n            int mid = (lo + hi) >>> 1;\n            if (sorted[mid] == target) return mid;\n            if (sorted[mid] < target) lo = mid + 1;\n            else hi = mid - 1;\n        }\n        return -1;\n    }\n}\n",
  "softTimeLimitSeconds": 300,
  "testTimeoutMs": 20000,
  "tests": [
    { "args": [[1, 3, 5, 7], 5], "expected": 2 },
    { "args": [[4], 4], "expected": 0 },
    { "args": [[1, 3, 5, 7], 7], "expected": 3 },
    { "args": [[1, 3], 3], "expected": 1 },
    { "args": [[1, 3, 5], 2], "expected": -1 },
    { "args": [[], 9], "expected": -1 }
  ]
}
```

Authoring checks for every file: starter compiles standalone; fix starters fail ≥ 1 test as shipped (integrity proves it); each write exercise's tests include the empty/degenerate case and the trap named in its row; 5–8 tests each; `testTimeoutMs: 20000`.

- [ ] **Step 2: Gate** — `npx vitest run bank/bank-integrity.test.ts` → all starters compile, every fix bug demonstrably fails, timeout lint green.

- [ ] **Step 3: Spot-grade two references** (one write, one fix — e.g. `dec-java-001` and `dbg-java-003`) via the spot-grade command in Global Constraints; expect Score 1.00 on correct references, and for `dbg-java-003` also grade the UNFIXED starter to see the mutate-vs-copy failure named in the output.

- [ ] **Step 4: Full suite + typecheck, then commit** (atrophy repo)

```powershell
git add bank/exercises
git commit -m "feat(bank): built-in java write/fix statics (10 exercises)"
```

---

### Task 8: Built-in bank — predict-output and cloze statics (8 exercises)

**Files (create):**
- `bank/exercises/code-reading/cr-java-001.json` — po, tier 1: integer division + compound assignment trace
- `bank/exercises/code-reading/cr-java-002.json` — po, tier 1: `StringBuilder` insert/delete/reverse sequence
- `bank/exercises/code-reading/cr-java-003.json` — po, tier 2: try/finally with early return (finally still runs; printed order is the answer)
- `bank/exercises/code-reading/cr-java-004.json` — po, tier 2: exception flow — `ArrayIndexOutOfBoundsException` caught, printed via `e.getClass().getSimpleName()` (spec §2.4 convention, snippet catches its own exception)
- `bank/exercises/api-memory/api-java-001.json` — cloze, tier 1: `map.getOrDefault(____, 0)` inverse — blank on the METHOD in a word-count loop; accepted `["getOrDefault"]`
- `bank/exercises/api-memory/api-java-002.json` — cloze, tier 1: `list.stream().sorted(Comparator.____()).toList()` for descending natural order; accepted `["reverseOrder"]`
- `bank/exercises/api-memory/api-java-003.json` — cloze, tier 2: `stream.collect(Collectors.____(w -> w.length()))` returning `Map<Integer, List<String>>`; accepted `["groupingBy"]`
- `bank/exercises/api-memory/api-java-004.json` — cloze, tier 2: `pq = new PriorityQueue<>(Comparator.____(arr -> arr[0]))` min-heap by first element; accepted `["comparingInt", "comparing"]`

**Interfaces:** continues Task 7's id sequences; nothing new consumed.

- [ ] **Step 1: Author all eight.** Predict-output snippets: first top-level class `Main`, deterministic only, `testTimeoutMs: 20000`. Every snippet hand-traced in the file's authoring commit message body (one line: expected stdout) so the reviewer can check without running. Clozes: exactly one `____`; schema-default timeout is fine (no JVM).

- [ ] **Step 2: Gate** — `npx vitest run bank/bank-integrity.test.ts` → every snippet runs cleanly and deterministically (the suite runs each twice under the JDK gate), cloze blanks present.

- [ ] **Step 3: Full suite + typecheck, then commit** (atrophy repo)

```powershell
git add bank/exercises
git commit -m "feat(bank): built-in java predict-output and cloze statics (8 exercises)"
```

---

### Task 9: Built-in bank — genericized tier-3 concurrency harness drills (3 exercises)

The spec §8 trio, no company references, each a `write-harness` with a shipped deterministic harness. These are the hardest content in the plan — budget accordingly and follow the harness template from Global Constraints exactly.

**Files (create):**
- `bank/exercises/syntax-recall/sr-java-003.json` — write-harness, tier 3: **write-preferring read-write lock** (`Solution` exposes `void lockRead()/unlockRead()/void lockWrite()/unlockWrite()` around an internal monitor). Checks (totalChecks 4): (1) two readers hold concurrently (latch-proved); (2) never writer-with-reader (invariant flag scanned during a bounded mixed run); (3) a queued writer blocks NEW readers (write-preference, latch-sequenced); (4) harness didn't crash (the catch-all check slot). Source-scan check is NOT included (that is the pack's rwlock drill; the built-in stays behavioral only).
- `bank/exercises/decomposition/dec-java-005.json` — write-harness, tier 3: **bounded blocking queue** (`put`/`take` on capacity 2). Checks (totalChecks 4): FIFO order over a 2P/2C bounded run; blocked `put` on full queue proceeds after `take` (latch-sequenced); no loss/duplication over 4 threads × 1k items; catch-all.
- `bank/exercises/api-memory/api-java-005.json` — write-harness, tier 3: **striped counter** (`increment(String key)`/`get(String key)` correct under 4 threads × 10k over 8 keys; prompt allows `synchronized`, `AtomicLong` map values, or `LongAdder`). Checks (totalChecks 3): exact totals per key; concurrent increments from 4 threads sum exactly; catch-all.

**Interfaces:**
- Consumes: `Atrophy.plan/check/report/watchdog` (shipped by Plan A beside the exercise's `testCode` at grade time).
- Produces: the built-in bank's first `write-harness` content — Task 17's smoke drills one of these.

- [ ] **Step 1: Author the three harnesses.** Hard requirements from Global Constraints applied here: `Atrophy.plan(N)` first, `Atrophy.watchdog(30_000)`, `testTimeoutMs: 45000`, try/catch(Throwable)/finally-report, ≤ 4 worker threads (the striped counter uses exactly 4), every await via `CountDownLatch`/`join` with ≥ 5s deadlines — no bare sleeps as synchronization. Starters compile standalone and FAIL the harness deterministically (an unimplemented `throw new UnsupportedOperationException` starter fails every check via the catch-all wrapper on the first call — that is a real result, not a harnessError, which is exactly what integrity requires of harness starters).
- [ ] **Step 2: Gate** — `npx vitest run bank/bank-integrity.test.ts`: harness starters grade to a real result with total == totalChecks; timeout lint (tier-3 floor) green.
- [ ] **Step 3: Reference-solution proof.** Write a correct reference for each (scratch files, not committed), spot-grade all three to Score 1.00. Then break one deliberately (e.g. reader count off by one) and confirm the specific named check fails — proves the checks discriminate, not just pass.
- [ ] **Step 4: Full suite + typecheck, then commit** (atrophy repo)

```powershell
git add bank/exercises
git commit -m "feat(bank): tier-3 java concurrency write-harness trio (rwlock, bounded queue, striped counter)"
```

---

### Task 10: Pack scaffold + wave-1 predict-output set (12 exercises, manifest §2.6)

First pack task: create the pack tree, land the lightest content, prove the whole pack pipeline (integrity-under-ATROPHY_BANK + merged doctor) before the heavy tasks lean on it.

**Files (create, in Java-OAs repo):**
- `atrophy-pack/exercises/code-reading/po-string-scp-intern.json` … one file per §2.6 row (12 total, ids = manifest slugs): `po-string-scp-intern`, `po-integer-cache`, `po-equals-no-hashcode`, `po-int-overflow`, `po-integer-min-negation`, `po-double-01-02`, `po-arrays-aslist-uoe`, `po-arrays-aslist-intarray`, `po-autoboxing-null-npe`, `po-twr-close-order`, `po-cme-map-remove`, `po-stream-lazy-no-terminal`
- `atrophy-pack/exercises/README.md` — 5 lines: what this pack is, the integrity gate command, "packs execute code — trusted dirs only", id = manifest slug rule, pointer to DRILL-MANIFEST.md

**Interfaces:**
- Consumes: manifest §2.6 rows (axis code-reading, kind predict-output, tier 1, P/D flags and per-row notes).
- Produces: the pack directory layout every later pack task adds to: `atrophy-pack/exercises/<axis>/<slug>.json`.

- [ ] **Step 1: Author the twelve.** Every snippet: class `Main`, deterministic, `testTimeoutMs: 20000`, exact-output traps per the manifest notes (`po-string-scp-intern` prints the four booleans; `po-twr-close-order` prints close messages in reverse; the three exception rows — `po-arrays-aslist-uoe`, `po-autoboxing-null-npe`, `po-cme-map-remove` — use the try/catch + `getSimpleName()` convention, NOT a schema field). Hand-trace each expected stdout into the commit body.
- [ ] **Step 2: Pack integrity gate** (from the atrophy repo): the ATROPHY_BANK command from Global Constraints → all 12 snippets run deterministically; the suite's vacuity guard proves the pack root actually loaded.
- [ ] **Step 3: Merged check:** the ATROPHY_PACKS doctor command → pack listed with 12 exercises, no id collisions with the base bank.
- [ ] **Step 4: Commit** (Java-OAs repo)

```powershell
git -C C:\Users\gurms\IdeaProjects\Java-OAs add atrophy-pack/exercises
git -C C:\Users\gurms\IdeaProjects\Java-OAs commit -m "feat(pack): wave-1 predict-output set (12) + pack scaffold"
```

---

### Task 11: Pack — Drill B API cloze tables (13 exercises, manifest §2.4)

**Files (create, Java-OAs repo):** `atrophy-pack/exercises/api-memory/a01-list-api.json` … `a13-stringbuilder.json` (ids = the 13 manifest slugs).

**Interfaces:** consumes manifest §2.4 rows + `R09 §6` source tables (the implementer reads `relearn/09_Cold_Coding_Without_LLM.md` §6 in Java-OAs for the actual API tables).

- [ ] **Step 1: Author the thirteen.** Each table = one cloze exercise, one `____` per file (the schema is single-blank; each file blanks the table's HIGHEST-signal cell per the manifest notes — e.g. `a02-map-api` blanks `merge`'s return semantics ("returns the ___ value" → accepted `["new"]`), `a04-queue-deque-api` blanks one of the throwing-vs-returning pairs, `a13-stringbuilder` blanks growth `cap*2+2`). Where a manifest note names the blank, use it; otherwise pick the method name the table exists to drill. `acceptedAnswers` includes every exact form the prompt legitimately admits (e.g. `["offer", "offerLast"]` where Deque aliases both).
- [ ] **Step 2: Gate + merged check** (same two commands as Task 10) → 25 pack exercises now, all green.
- [ ] **Step 3: Commit** (Java-OAs repo): `git -C ... commit -m "feat(pack): Drill B API cloze tables (13)"`

---

### Task 12: Pack — Tier-A DSA and speed targets (8 exercises, manifest §2.5)

**Files (create, Java-OAs repo):** `atrophy-pack/exercises/decomposition/min-stack.json`, `coin-change.json`, `number-of-islands.json`, `search-rotated-sorted-array.json`, `kadane-max-subarray.json`, `two-sum.json`; `atrophy-pack/exercises/syntax-recall/reverse-linked-list.json`, `bfs-levels-dist.json`.

**Interfaces:** consumes manifest §2.5 rows; produces nothing later tasks depend on.

- [ ] **Step 1: Author the eight**, kind `write`, json-tests, per-row requirements from the manifest notes verbatim:
  - `min-stack`: op-driver `(String[] ops, int[][] args) -> List<Object>` (push/pop/top/getMin; `null` result rows for void ops); tier 2.
  - `coin-change`: `int coinChange(int[] coins, int amount)`; include amount 0 → 0 and unreachable → -1.
  - `number-of-islands`: reference sinks the grid — every test vector is an independent literal, never reused.
  - `search-rotated-sorted-array`: include the two-element `<=` edge case (`[3,1], target 1`).
  - `kadane-max-subarray`: NEEDS-AUTHORING gap — standard spec authored fresh: `int maxSubarray(int[] nums)`, all-negative case included.
  - `two-sum`: ascending indices, exactly one solution guaranteed (say so in the prompt).
  - `reverse-linked-list`: `int[] reverseList(int[] values)` — the ListNode adapter framing lives in the prompt ("you receive the list as an array; return the reversed traversal"), keeping tests `int[] -> int[]`.
  - `bfs-levels-dist`: adjacency list as `int[][]`, `int bfsDistance(int[][] adj, int src, int dst)` → -1 when unreachable; `size = q.size()` inner-loop pattern named in the prompt.
  - Soft limits from the manifest's soft-min column (minutes × 60); `testTimeoutMs: 20000`.
- [ ] **Step 2: Reference-solution proof:** spot-grade `min-stack` (the op-driver — the shape most likely to be mis-authored) and `kadane-max-subarray` (the freshly authored one) to Score 1.00.
- [ ] **Step 3: Gate + merged check** → 33 pack exercises. **Step 4: Commit** (Java-OAs): `"feat(pack): Tier-A DSA + speed targets (8)"`

---

### Task 13: Pack — design ten objective write drills (10 exercises, manifest §2.2)

**Files (create, Java-OAs repo):** `atrophy-pack/exercises/decomposition/browser-history.json`, `lru-cache.json`, `snake-game.json`, `fix-message-checksum.json`, `futures-tick-pnl.json`, `position-apply-fill.json`, `twap-schedule.json`, `execid-dedup.json`, `feedhandler-gap-detect.json`, `pat-state-orderlifecycle.json`.

**Interfaces:** consumes manifest §2.2 rows + the named source sections in Java-OAs docs (D03/D05/D06/R08/R10) for test vectors.

- [ ] **Step 1: Author the ten**, all kind `write` json-tests, op-driver convention where the manifest says so (`(String[] ops, ...args) -> List<Object>`; results row per op, `null` for void). Non-negotiable hidden tests from the notes column:
  - `browser-history`: visit clears the forward stack; back/forward past the ends clamp.
  - `lru-cache`: get refreshes recency; overwrite updates without evicting; eviction order after mixed get/put.
  - `snake-game`: tail removed BEFORE self-collision check (moving into the vacating cell is legal) — this exact vector.
  - `fix-message-checksum`: BodyLength excludes tags 8/9; checksum covers all bytes including SOH; `SendingTime` is an argument (injected clock rule).
  - `futures-tick-pnl`: contract table (ES/CL/ZN/GC/6E) as reference data in the prompt; the doc's check vector (1 tick × $12.50 × 10 = $125). All money in integer cents or exact doubles that are dyadic (12.50 is exact) — state the unit in the prompt.
  - `position-apply-fill`: increase, partial close, close-to-flat, and long→short flip vectors — all four.
  - `twap-schedule`: duration < interval (no divide-by-zero); remainder distribution loses zero contracts (sum of slices == total).
  - `execid-dedup`: exchange-resent duplicate ExecutionReports dropped; position reflects deduped fills only.
  - `feedhandler-gap-detect`: interleaved A/B feeds, out-of-order within tolerance, duplicate-after-gap.
  - `pat-state-orderlifecycle`: result row per op = state after the op; illegal transitions THROW and the driver records which ops threw (the op-driver catches per-op and appends `"threw"` — specify this shape in the prompt so references match).
- [ ] **Step 2: Reference-solution proof:** spot-grade `position-apply-fill` (the flip branch) and `snake-game` (the vacating-cell vector) to 1.00.
- [ ] **Step 3: Gate + merged check** → 43 pack exercises. **Step 4: Commit** (Java-OAs): `"feat(pack): design objective write drills (10)"`

---

### Task 14: Pack — Drill A pattern-recall five (5 exercises, manifest §2.3)

**Files (create, Java-OAs repo):** `atrophy-pack/exercises/syntax-recall/p01-equals-hashcode.json`, `lambda-effectively-final.json`; `atrophy-pack/exercises/api-memory/chm-atomic-counter.json`, `comparator-chains.json`, `pq-topk.json`.

**Interfaces:** consumes manifest §2.3 rows; `p01-equals-hashcode` and `chm-atomic-counter` are `write-harness` (the pack's first harness content — reuse the Task 9 harness discipline wholesale).

- [ ] **Step 1: Author.**
  - `p01-equals-hashcode` (write-harness, totalChecks 5, `testTimeoutMs: 30000`, watchdog 15_000): reflexive, symmetric+transitive across equal/unequal pairs, `hashCode` equality on equals, HashMap round-trip (put then get by an equal-but-distinct key), catch-all.
  - `chm-atomic-counter` (write-harness, totalChecks 3, `testTimeoutMs: 45000`, watchdog 30_000, tier 1 but 8 threads × 10k per the manifest — the counting workload IS the drill): exact totals over 16 keys; no key lost; catch-all.
  - `comparator-chains` (write, json-tests): 3-key chain (`comparing.thenComparing.thenComparing`), `reversed()` variant, `nullsFirst` variant — encode rows as `String[][] -> List<List<String>>` sorted tables.
  - `pq-topk` (write, json-tests): kth-largest via a size-K min-heap; include duplicates and k == n.
  - `lambda-effectively-final` (write, json-tests): accumulate via `int[]` holder and via stream-sum — two functions? No: ONE graded function `sumOver(int[] nums, int target)` whose prompt mandates using a lambda with a captured local (the graded surface is behavior; the capture pattern is the drill's framing).
- [ ] **Step 2: Gate + merged check** (harness starters must grade to real results) → 48 pack exercises. **Step 3: Commit** (Java-OAs): `"feat(pack): Drill A pattern-recall five"`

---

### Task 15: Pack — concurrency fix-harness five + two singles (7 exercises, manifest §2.1 rows 4–10)

**Files (create, Java-OAs repo):**
- `atrophy-pack/exercises/debugging/fix-chm-counting-race.json`, `fix-lost-update-counter.json`, `fix-threadlocal-pool-leak.json`, `fix-sleep-instead-of-wait.json`, `fix-rwlock-interrupt-leak.json` (all fix-harness)
- `atrophy-pack/exercises/syntax-recall/parallel-mergesort-fjp.json` (write, json-tests)
- `atrophy-pack/exercises/code-reading/po-pass-by-value.json` (predict-output)

**Interfaces:** consumes manifest §2.1 rows; the five fix-harness starters ship REAL planted bugs that fail deterministically as shipped (integrity requirement), fixed versions pass all checks.

- [ ] **Step 1: Author the five fix-harness drills.** Per-row musts (manifest notes verbatim):
  - `fix-chm-counting-race`: starter `map.put(k, map.getOrDefault(k, 0) + 1)` under 8×10k over 16 keys — fails every run; accept `merge` or `compute` (and plain `synchronized` — the harness checks totals, not the API used). totalChecks 3 (exact grand total; per-key totals; catch-all). `testTimeoutMs: 30000`.
  - `fix-lost-update-counter`: 2 threads × 1M `count++` must total exactly 2,000,000; accept synchronized/AtomicInteger/LongAdder (behavioral check only).
  - `fix-threadlocal-pool-leak`: single-thread executor, task A sets, task B must see `get() == null` — deterministic by construction; fix is `remove()` in finally.
  - `fix-sleep-instead-of-wait`: starter holds the monitor through `Thread.sleep` → latch-proved consumer starvation within a bounded window; fix is `wait()`/`notifyAll()`. The harness detects the STARTER deterministically: it times a monitor-acquire attempt with a generous bound (≥ 5s) while the sleeper holds it — the sleeping thread provably holds the lock the whole time (no race: sleep does not release the monitor).
  - `fix-rwlock-interrupt-leak`: the R01 §9.3 edge — interrupt a waiting writer, then assert a reader can still acquire (starter leaks `writeRequests` in the InterruptedException path; fix decrements in a catch/finally before rethrowing). totalChecks 3, watchdog 15_000.
- [ ] **Step 2: Author the two singles.** `parallel-mergesort-fjp`: pure `int[] -> int[]` json-tests (the manifest's "cleanest candidate"; the optional THRESHOLD-splitting harness assert is wave-2 scope, omit); prompt mandates ForkJoinPool + RecursiveTask framing. `po-pass-by-value`: exact `42` / `hello world` / `original` outputs per R05 §1.
- [ ] **Step 3: Gate + merged check** — integrity demonstrates all five planted bugs failing and all starters grading to real results. **Step 4: Reference proof:** fix each of the five (scratch), spot-grade to 1.00. **Step 5: Commit** (Java-OAs): `"feat(pack): concurrency fix-harness five + mergesort + pass-by-value"` → 55 pack exercises.

---

### Task 16: Pack — the three concurrency builders (3 exercises, manifest §2.1 rows 1–3)

The heaviest authoring in wave 1. One task so one reviewer sees all three harnesses together.

**Files (create, Java-OAs repo):** `atrophy-pack/exercises/syntax-recall/rwlock-from-scratch.json`, `prodcons-waitnotify.json`, `treiber-stack.json` (all write-harness, tier 2, `testTimeoutMs: 45000`, watchdog 30_000).

**Interfaces:** consumes manifest §2.1 rows 1–3 incl. the NEEDS-AUTHORING fixes; the static-source checks read `Solution.java` from the scratch dir (spec §3.3 grants harness file access).

- [ ] **Step 1: `rwlock-from-scratch`** (totalChecks 5, soft 25 min): behavioral checks from the built-in Task 9 rwlock PLUS the source-scan check the manifest requires — read `Solution.java`, reject `java.util.concurrent` imports (`Atrophy.check("no java.util.concurrent imports", !src.matches("(?s).*import\\s+java\\.util\\.concurrent.*"))`). **NEEDS-AUTHORING resolutions (both):** the DR1 defects are FIXED in this exercise's reference framing — the prompt's worked example uses a writer count that matches its loop bound, and the reference solution unlocks in `finally`. (DR1's bugs become wave-2 planted-bug drills; nothing here inherits them.) Reader watermark ≥ 2 concurrent readers latch-proved; queued-writer-blocks-new-readers latch-sequenced.
- [ ] **Step 2: `prodcons-waitnotify`** (totalChecks 4): 3P/3C × 10k items — no loss, no duplication, terminates under the watchdog; source-scan check: the wait loop uses `while`, not `if` (`Atrophy.check("wait guarded by while", src.matches("(?s).*while\\s*\\([^)]*\\)\\s*\\{?\\s*[^}]*wait\\(\\).*") || …)` — implement as: strip comments, find the `wait()` call, assert the nearest enclosing guard keyword is `while`; a regex is acceptable if it rejects the plain `if (…) wait()` shape the manifest names as the rejection trigger).
- [ ] **Step 3: `treiber-stack`** (totalChecks 3): 8 threads (4 push then 4 pop waves) × 1000 — popped multiset equals pushed multiset; empty-pop returns the sentinel the prompt specifies; catch-all. Prompt mandates `AtomicReference` CAS (source-scan: reject `synchronized` — this drill is the lock-free one).
- [ ] **Step 4: Gate + merged check + reference proof** — all three starters grade to real failing results; references score 1.00; break-one-check discrimination probe on `rwlock-from-scratch` (remove write-preference from the reference → exactly the queued-writer check fails). **Step 5: Commit** (Java-OAs): `"feat(pack): concurrency builders — rwlock, prodcons, treiber (wave 1 complete: 58)"`.

---

### Task 17: Merged verification, docs, wrap

**Files:**
- Modify: `README.md` (atrophy repo — the L167 one-liner: the built-in bank now ships Java exercises; one sentence in the language table section)
- Modify: `CLAUDE.md` (atrophy repo — bank layout line gains the java id prefixes; one line)
- No pack files.

**Interfaces:** consumes everything; produces the Plan B completion evidence.

- [ ] **Step 1: Full merged run.** From the atrophy repo: base integrity (`npx vitest run bank/bank-integrity.test.ts`), pack integrity (ATROPHY_BANK command), merged doctor (ATROPHY_PACKS command — expect 58 pack exercises listed, zero collisions), `npm test`, `npm run typecheck`.
- [ ] **Step 2: Built-CLI smoke.** `npm run build`, then with `ATROPHY_NO_SYNC=1` + throwaway `ATROPHY_DB` + `ATROPHY_PACKS` set, through `node dist/cli/index.js`: (a) `drill --lang java --show` selects a java exercise from a java-bearing axis (proves Task 1 end to end when the axis chosen has only generator content — force with `--axis syntax-recall`); (b) spot-grade one exercise from each content task family: a generated `sr-java-cond` variant, `dbg-java-001` unfixed (fails) and fixed (1.00), one §2.6 predict, `min-stack`, `fix-lost-update-counter` fixed, `rwlock-from-scratch` reference. Record each command + score in the report.
- [ ] **Step 3: Docs.** The two one-liners above; verify `npm run typecheck` still clean.
- [ ] **Step 4: Commit** (atrophy repo): `docs: java content in the built-in bank (plan B wrap)`. The pack repo needs no commit here unless smoke fixes touched it — if a pack exercise needed fixing, commit that in Java-OAs with a `fix(pack):` message naming the drill.

---

## Self-Review

**Spec coverage.** §5 four families → Tasks 3–6 (sr/dbg/cr/api). §5 generator tests (schema+determinism+real-grading spot checks) → each family task's test rows + integrity sampling extensions (Tasks 4–5 Step 1) + manual spot-grades. §8 built-in bank "4–6 per axis" → statics: SR 3 (2 write + rwlock harness), DBG 4, CR 4, API 5 (4 cloze + striped-counter harness), DEC 6 (5 write + bounded-queue harness) — SR sits one under the band's floor as statics, deliberately: the `sr-java-cond` family supplies endless SR variants, and axis availability counts families after Task 1. §8 genericized trio → Task 9. §8 wave 1 (58) → Tasks 10–16 = 12+13+8+10+5+7+3 = 58 ✓. §2.4 conventions (Main class, compiling starters, try/catch exception convention, ops-driver) → Global Constraints + Tasks 8/10/13. Spec §3.3 determinism duties → Global Constraints + Tasks 9/15/16. Plan A review carry-ins: L158 → Task 1; timeout lint → Task 2; L170 standalone-compile → Global Constraints; L154 "number only" → not applicable (wave 1 ships zero recall exercises; the guidance transfers to Plan C where recall lands).

**Placeholder scan.** Content tasks intentionally specify per-exercise contracts + one fully-worked exemplar rather than 79 complete JSON bodies; every exercise has its id, kind, tier, functional spec, trap vectors, and gate named — nothing is "TBD" and no step says "handle edge cases" without naming them. The two source-scan regexes in Task 16 are specified by intent with the acceptable implementation named.

**Type consistency.** `availableAxes(bank, language?, generators = [])` defined in Task 1 and used nowhere else by name; generator families registered as `sr-java-cond`/`dbg-java-scan`/`cr-java-trace`/`api-java-blank` consistently; id sequences: sr-java-001..003, dbg-java-001..004, cr-java-001..004, api-java-001..005, dec-java-001..005 — Task 9's bounded queue is `dec-java-005` (Task 7 ends at dec-java-004) ✓; pack ids are manifest slugs throughout.
