# Java Engine Support Implementation Plan (Plan A of 3)

> **Amended during execution** — the SDD ledger's constraint amendments (notably the six-flag `JAVA_RUNTIME_FLAGS`) supersede this text where they differ.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `atrophy drill --lang java` fully work: schema, Java grading (reflection harness + testCode kinds), recall kind, whiteboard mode, multi-dir packs, doctor/CLI/CI support.

**Architecture:** Java code exercises grade via `javac` + `java` subprocesses through the existing sandboxed runner. A static reflection harness (`engine/java/Harness.java`, shipped as a real resource file) reads `tests.json` and implements the same `ATROPHY_RESULT` marker contract as the Python/Node harnesses. Behavioral drills ship their own harness (`testCode`) as new kinds `write-harness`/`fix-harness`. Packs merge extra bank directories on top of the built-in bank.

**Tech Stack:** TypeScript (strict, ESM NodeNext), zod v4, vitest, better-sqlite3, JDK 21 (Temurin in CI).

**Spec:** `docs/superpowers/specs/2026-08-13-java-language-support-design.md`. Plan B (generators + built-in bank content + pack wave 1) and Plan C (waves 2–3 + wave X) follow after this plan is complete.

## Global Constraints

- ESM + NodeNext: **relative imports use `.js` extensions inside `.ts` files** (`import { x } from "./javatool.js"`).
- TypeScript strict + `noUncheckedIndexedAccess`; `npm run typecheck` must stay green after every task.
- JDK floor: **21**. All `java` invocations pin `-Dfile.encoding=UTF-8 -Duser.language=en -Duser.country=US -Duser.timezone=UTC`; all `javac` invocations pass `-encoding UTF-8`.
- CI runs ubuntu + windows, Node 22/24 — everything must be Windows-safe (no POSIX-only paths, `.exe` suffix for `ATROPHY_JAVA_HOME` tools).
- No new npm dependencies.
- Result marker contract (all languages): one stdout line `ATROPHY_RESULT {"passed":N,"total":M,"failures":[...]}`; parser takes the **last** marker line.
- Java-dependent tests: gate with `describe.skipIf(!hasJdk())` AND print a loud `console.warn` when skipping. Never silently skip.
- Set `ATROPHY_NO_SYNC=1` and a throwaway `ATROPHY_DB` for any command that records sessions.
- Tests run with `npx vitest run <file>` (no watch mode in CI or verification steps).
- Commit after every task on branch `feat/java-language-support`.

## File Structure

| File | Responsibility |
|---|---|
| `bank/schema.ts` (modify) | `"java"` language; `recall`, `write-harness`, `fix-harness` kinds; `submitPolicy`; `totalUnits`; multi-dir `loadBank` |
| `cli/config.ts` (create) | Shared `~/.atrophy/config.json` read/write (moved from publish.ts) + `packDirs()` |
| `cli/publish.ts` (modify) | Re-import config helpers from `cli/config.ts` |
| `cli/index.ts` (modify) | `bankDirs()` (base + packs), `parseLang`, help text, baseline language filter |
| `engine/select.ts` (modify) | `availableAxes(bank, language?)` helper |
| `engine/javatool.ts` (create) | JDK discovery, pinned flags, compile timeout, resource-dir resolution, `hasJdk()` |
| `engine/java/Harness.java` (create) | Reflection harness: JSON parser/serializer + method invocation |
| `engine/java/Atrophy.java` (create) | Optional helper for `testCode` authors: `plan/check/report/watchdog` |
| `engine/runner.ts` (modify) | win32 `TEMP`/`TMP` env passthrough |
| `engine/grader.ts` (modify) | Java json-tests path, testCode path (+ `totalChecks` enforcement), java predict-output, `gradeRecall` |
| `engine/scoring.ts` (modify) | Clamp correctness to [0,1] in `exerciseScore` |
| `engine/session.ts` (modify) | `recall` drill flow, whiteboard single-submit, harness kinds in `codeDrill`, arg-less failure rendering |
| `cli/doctor.ts` (modify) | `checkJava`, `checkPacks` |
| `bank/bank-integrity.test.ts` (modify) | `ATROPHY_BANK` override; Java suites (own describe, 300s budgets, JDK-gated) |
| `package.json` (modify) | `files` += `"engine/java"` |
| `.github/workflows/ci.yml` (modify) | `actions/setup-java` Temurin 21 |
| `README.md`, `CLAUDE.md` (modify) | Language/pack/kind documentation |

---

### Task 1: Schema — `"java"` language

**Files:**
- Modify: `bank/schema.ts` (LANGUAGES const, line 13)
- Test: `bank/schema.test.ts`

**Interfaces:**
- Produces: `LANGUAGES` includes `"java"`; `Language` type gains `"java"`. Everything else unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `bank/schema.test.ts` inside `describe("parseExercise")`:

```ts
  it("accepts java code, predict-output, and cloze exercises", () => {
    const javaWrite = {
      ...valid,
      id: "sr-java-001",
      language: "java",
      starterCode: "public class Solution { static int f(int x) { throw new UnsupportedOperationException(); } }",
    };
    expect(parseExercise(JSON.stringify(javaWrite)).language).toBe("java");
    const predict = { id: "cr-java-001", kind: "predict-output", axis: "code-reading", language: "java", tier: 1, title: "t", prompt: "p", softTimeLimitSeconds: 120, snippet: "public class Main { public static void main(String[] a) { System.out.println(1); } }" };
    expect(parseExercise(JSON.stringify(predict)).language).toBe("java");
    const cloze = { id: "api-java-001", kind: "cloze", axis: "api-memory", language: "java", tier: 1, title: "t", prompt: "p", softTimeLimitSeconds: 60, snippet: "int n = list.____();", acceptedAnswers: ["size"] };
    expect(parseExercise(JSON.stringify(cloze)).language).toBe("java");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run bank/schema.test.ts -t "accepts java"`
Expected: FAIL — zod rejects `language: "java"` (`Invalid enum value`).

- [ ] **Step 3: Implement**

In `bank/schema.ts` change:

```ts
export const LANGUAGES = ["python", "javascript", "java"] as const;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run bank/schema.test.ts && npm run typecheck`
Expected: PASS (all existing tests too — `Language` widens without breaking users).

- [ ] **Step 5: Commit**

```bash
git add bank/schema.ts bank/schema.test.ts
git commit -m "feat(schema): add java to LANGUAGES"
```

---

### Task 2: Schema — `recall` kind

**Files:**
- Modify: `bank/schema.ts` (union at line 48, `totalUnits` at line 90, type exports)
- Test: `bank/schema.test.ts`

**Interfaces:**
- Produces: union member `{ kind: "recall", ...baseFields, language: "any", acceptedAnswers: string[], reveal?: string }`; exported type `RecallExercise = Extract<Exercise, { kind: "recall" }>`; `totalUnits(recall) === 1`.

- [ ] **Step 1: Write the failing tests**

Append to `bank/schema.test.ts`:

```ts
describe("recall kind", () => {
  const recall = {
    id: "rec-any-001",
    kind: "recall",
    axis: "decomposition",
    language: "any",
    tier: 1,
    title: "Birthday paradox",
    prompt: "How many people for a >50% shared-birthday chance?",
    softTimeLimitSeconds: 120,
    acceptedAnswers: ["23"],
    reveal: "P(no collision) drops below 0.5 at n=23.",
  };
  it("accepts recall with reveal optional", () => {
    expect(parseExercise(JSON.stringify(recall)).kind).toBe("recall");
    const { reveal: _reveal, ...noReveal } = recall;
    expect(parseExercise(JSON.stringify(noReveal)).kind).toBe("recall");
  });
  it("counts one unit and rejects concrete languages + empty answers", () => {
    expect(totalUnits(parseExercise(JSON.stringify(recall)))).toBe(1);
    expect(() => parseExercise(JSON.stringify({ ...recall, language: "java" }))).toThrow(BankError);
    expect(() => parseExercise(JSON.stringify({ ...recall, acceptedAnswers: [] }))).toThrow(BankError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run bank/schema.test.ts -t "recall"`
Expected: FAIL — `Invalid discriminator value`.

- [ ] **Step 3: Implement**

In `bank/schema.ts`, add a union member after the `outline` member:

```ts
  /** Concept/puzzle recall: short answer, numeric-tolerant match (1/4 == 0.25 == 25%). */
  z.object({
    kind: z.literal("recall"),
    ...baseFields,
    language: z.literal("any"),
    acceptedAnswers: z.array(z.string().min(1)).min(1),
    /** Derivation shown after grading; never graded. */
    reveal: z.string().min(1).optional(),
  }),
```

Add the type export next to the others:

```ts
export type RecallExercise = Extract<Exercise, { kind: "recall" }>;
```

Extend `totalUnits`'s switch:

```ts
    case "recall":
      return 1;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run bank/schema.test.ts && npm run typecheck`
Expected: PASS. (If `totalUnits` complains about non-exhaustive switch elsewhere, the compiler is pointing at code Task 5–14 updates; only `totalUnits` must be exhaustive now.)

- [ ] **Step 5: Commit**

```bash
git add bank/schema.ts bank/schema.test.ts
git commit -m "feat(schema): add recall exercise kind"
```

---

### Task 3: Schema — `write-harness` / `fix-harness` kinds

**Files:**
- Modify: `bank/schema.ts`
- Test: `bank/schema.test.ts`

**Interfaces:**
- Produces: union members `{ kind: "write-harness" | "fix-harness", ...baseFields, language: "java", starterCode: string, testCode: string, totalChecks: int >= 1 }`; exports `HarnessExercise = Extract<Exercise, { kind: "write-harness" | "fix-harness" }>`, `CodeLikeExercise = CodeExercise | HarnessExercise`, and `isHarness(ex): ex is HarnessExercise`; `totalUnits(harness) === totalChecks`.
- Consumed by: grader (Task 10), session (Task 12), integrity tests (Task 14).

- [ ] **Step 1: Write the failing tests**

Append to `bank/schema.test.ts`:

```ts
describe("harness kinds", () => {
  const harness = {
    id: "conc-java-001",
    kind: "write-harness",
    axis: "syntax-recall",
    language: "java",
    tier: 3,
    title: "Bounded blocking queue",
    prompt: "Implement put/take with wait/notifyAll.",
    softTimeLimitSeconds: 1500,
    testTimeoutMs: 30000,
    starterCode: "public class Solution { /* ... */ }",
    testCode: "public class Harness { public static void main(String[] a) { Atrophy.plan(3); Atrophy.report(); } }",
    totalChecks: 3,
  };
  it("accepts both harness kinds and counts totalChecks units", () => {
    const ex = parseExercise(JSON.stringify(harness));
    expect(ex.kind).toBe("write-harness");
    expect(totalUnits(ex)).toBe(3);
    expect(parseExercise(JSON.stringify({ ...harness, id: "conc-java-002", kind: "fix-harness" })).kind).toBe("fix-harness");
  });
  it.each([
    ["non-java language", { ...harness, language: "python" }],
    ["missing testCode", { ...harness, testCode: undefined }],
    ["zero totalChecks", { ...harness, totalChecks: 0 }],
    ["fractional totalChecks", { ...harness, totalChecks: 1.5 }],
  ])("rejects %s", (_name, bad) => {
    expect(() => parseExercise(JSON.stringify(bad))).toThrow(BankError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run bank/schema.test.ts -t "harness"`
Expected: FAIL — `Invalid discriminator value`.

- [ ] **Step 3: Implement**

In `bank/schema.ts`, below `codeFields`, add:

```ts
/** Kinds where the exercise ships its own Java test harness (behavioral drills). */
const harnessFields = {
  ...baseFields,
  language: z.literal("java"),
  /** Written into Solution.java for the user to edit (for "fix-harness": the buggy code). */
  starterCode: z.string().min(1),
  /** A complete `public class Harness` with main(); must print one ATROPHY_RESULT line. */
  testCode: z.string().min(1),
  /** Declared number of checks; the harness's reported total must match at grade time. */
  totalChecks: z.number().int().min(1),
};
```

Add two union members after `fix`:

```ts
  /** Write-from-spec, graded by the exercise's own Java harness (concurrency etc.). */
  z.object({ kind: z.literal("write-harness"), ...harnessFields }),
  /** Planted bug, graded by the exercise's own Java harness. */
  z.object({ kind: z.literal("fix-harness"), ...harnessFields }),
```

Add types + guard next to `isCode`:

```ts
export type HarnessExercise = Extract<Exercise, { kind: "write-harness" | "fix-harness" }>;
export type CodeLikeExercise = CodeExercise | HarnessExercise;

export function isHarness(ex: Exercise): ex is HarnessExercise {
  return ex.kind === "write-harness" || ex.kind === "fix-harness";
}
```

Extend `totalUnits`:

```ts
    case "write-harness":
    case "fix-harness":
      return ex.totalChecks;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run bank/schema.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bank/schema.ts bank/schema.test.ts
git commit -m "feat(schema): add write-harness/fix-harness kinds (testCode + totalChecks)"
```

---

### Task 4: Schema — `submitPolicy` (whiteboard mode field)

**Files:**
- Modify: `bank/schema.ts`
- Test: `bank/schema.test.ts`

**Interfaces:**
- Produces: optional `submitPolicy?: "loop" | "single"` on `write`, `fix`, `write-harness`, `fix-harness` (absent ⇒ loop). Session consumes it in Task 12. Kept `.optional()` (not `.default()`) so existing fixtures/exercise JSONs stay valid without churn.

- [ ] **Step 1: Write the failing tests**

Append to `bank/schema.test.ts`:

```ts
describe("submitPolicy", () => {
  it("accepts single on write and harness kinds; rejects junk", () => {
    expect(parseExercise(JSON.stringify({ ...valid, submitPolicy: "single" })).submitPolicy).toBe("single");
    expect(parseExercise(JSON.stringify(valid)).submitPolicy).toBeUndefined();
    expect(() => parseExercise(JSON.stringify({ ...valid, submitPolicy: "yolo" }))).toThrow(BankError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run bank/schema.test.ts -t "submitPolicy"`
Expected: FAIL — unknown key is stripped by zod, so `.submitPolicy` is `undefined` where `"single"` was expected.

- [ ] **Step 3: Implement**

In `bank/schema.ts`, define above `codeFields`:

```ts
/** "single" = whiteboard mode: exactly one graded submission, no fix-and-resubmit loop. */
const submitPolicySchema = z.enum(["loop", "single"]).optional();
```

Add `submitPolicy: submitPolicySchema,` to BOTH `codeFields` and `harnessFields`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run bank/schema.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bank/schema.ts bank/schema.test.ts
git commit -m "feat(schema): optional submitPolicy for whiteboard drills"
```

---

### Task 5: Schema — multi-directory `loadBank`

**Files:**
- Modify: `bank/schema.ts` (`loadBank`, line 124)
- Test: `bank/schema.test.ts`

**Interfaces:**
- Produces: `loadBank(dirs: string | string[]): Exercise[]` — merges all dirs; duplicate id anywhere throws `BankError` naming both files. Single-string calls behave exactly as before (all existing callers compile unchanged).

- [ ] **Step 1: Write the failing tests**

Append to `bank/schema.test.ts` (add `mkdtempSync, mkdirSync, rmSync, writeFileSync` from `node:fs`, `tmpdir` from `node:os` to imports):

```ts
describe("loadBank multi-dir", () => {
  function tempBank(files: Record<string, object>): string {
    const dir = mkdtempSync(join(tmpdir(), "atrophy-bank-"));
    for (const [name, ex] of Object.entries(files)) {
      writeFileSync(join(dir, name), JSON.stringify(ex), "utf8");
    }
    return dir;
  }
  it("merges several directories", () => {
    const a = tempBank({ "a.json": valid });
    const b = tempBank({ "b.json": { ...valid, id: "sr-py-002" } });
    try {
      const bank = loadBank([a, b]);
      expect(bank.map((e) => e.id).sort()).toEqual(["sr-py-001", "sr-py-002"]);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
  it("fails loudly on duplicate ids across directories, naming both files", () => {
    const a = tempBank({ "a.json": valid });
    const b = tempBank({ "b.json": valid });
    try {
      expect(() => loadBank([a, b])).toThrowError(/duplicate exercise id: sr-py-001.*a\.json.*b\.json/s);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run bank/schema.test.ts -t "multi-dir"`
Expected: FAIL — `readdirSync` on an array throws (loadBank takes a single string today).

- [ ] **Step 3: Implement**

Replace `loadBank` in `bank/schema.ts`:

```ts
/** Recursively load every *.json exercise under one or more bank directories. */
export function loadBank(dirs: string | string[]): Exercise[] {
  const roots = Array.isArray(dirs) ? dirs : [dirs];
  const exercises: Exercise[] = [];
  const seen = new Map<string, string>(); // id -> first file that declared it
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".json")) {
        const ex = parseExercise(readFileSync(full, "utf8"), full);
        const first = seen.get(ex.id);
        if (first) throw new BankError(`duplicate exercise id: ${ex.id} (${first} and ${full})`);
        seen.set(ex.id, full);
        exercises.push(ex);
      }
    }
  };
  for (const root of roots) walk(root);
  return exercises;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run bank/ && npm run typecheck`
Expected: PASS (including the existing "loads every shipped seed exercise" test).

- [ ] **Step 5: Commit**

```bash
git add bank/schema.ts bank/schema.test.ts
git commit -m "feat(bank): loadBank accepts multiple directories with cross-dir duplicate detection"
```

---

### Task 6: `cli/config.ts` — shared config + `packDirs()`

**Files:**
- Create: `cli/config.ts`
- Create: `cli/config.test.ts`
- Modify: `cli/publish.ts` (lines 53–79: delete the local config code, import from `./config.js`)

**Interfaces:**
- Produces: `interface AtrophyConfig { leaderboard?: { token?: string; handle?: string; url?: string }; packs?: string[] }`; `configPath(): string`; `readConfig(): AtrophyConfig`; `writeConfig(c: AtrophyConfig): void`; `packDirs(env?: NodeJS.ProcessEnv): string[]` (ATROPHY_PACKS split on `path.delimiter`, then config `packs`, order preserved, blanks dropped).
- Consumed by: publish.ts (existing behavior unchanged), cli/index.ts (Task 7), doctor (Task 13).

- [ ] **Step 1: Write the failing tests**

Create `cli/config.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packDirs, readConfig } from "./config.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  delete process.env.ATROPHY_CONFIG;
});

function withConfig(json: string): void {
  const dir = mkdtempSync(join(tmpdir(), "atrophy-config-"));
  const file = join(dir, "config.json");
  writeFileSync(file, json, "utf8");
  process.env.ATROPHY_CONFIG = file;
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
}

describe("readConfig", () => {
  it("reads packs and tolerates a UTF-8 BOM", () => {
    withConfig("\uFEFF" + JSON.stringify({ packs: ["C:/packs/deshaw"] }));
    expect(readConfig().packs).toEqual(["C:/packs/deshaw"]);
  });
  it("returns {} for missing or broken config", () => {
    process.env.ATROPHY_CONFIG = join(tmpdir(), "nope", "config.json");
    expect(readConfig()).toEqual({});
  });
});

describe("packDirs", () => {
  it("combines ATROPHY_PACKS (delimiter-separated) with config packs, env first", () => {
    withConfig(JSON.stringify({ packs: ["/from/config"] }));
    const env = { ...process.env, ATROPHY_PACKS: ["/pack/a", "", "/pack/b"].join(delimiter) };
    expect(packDirs(env)).toEqual(["/pack/a", "/pack/b", "/from/config"]);
  });
  it("is empty with no env and no config entry", () => {
    withConfig("{}");
    const env = { ...process.env };
    delete env.ATROPHY_PACKS;
    expect(packDirs(env)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run cli/config.test.ts`
Expected: FAIL — `Cannot find module './config.js'`.

- [ ] **Step 3: Implement**

Create `cli/config.ts` (the config code moves verbatim from publish.ts, gaining `packs`):

```ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export interface AtrophyConfig {
  leaderboard?: { token?: string; handle?: string; url?: string };
  /** Extra exercise-bank directories merged on top of the built-in bank. */
  packs?: string[];
}

export function configPath(): string {
  return process.env.ATROPHY_CONFIG ?? join(homedir(), ".atrophy", "config.json");
}

export function readConfig(): AtrophyConfig {
  try {
    // tolerate a UTF-8 BOM (hand-edited or PowerShell-written configs)
    return JSON.parse(readFileSync(configPath(), "utf8").replace(/^\uFEFF/, "")) as AtrophyConfig;
  } catch {
    return {};
  }
}

export function writeConfig(config: AtrophyConfig): void {
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config, null, 2), "utf8");
}

/** Additive pack directories: ATROPHY_PACKS (path-delimiter separated) then config packs. */
export function packDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const fromEnv = (env.ATROPHY_PACKS ?? "")
    .split(delimiter)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...fromEnv, ...(readConfig().packs ?? [])];
}
```

In `cli/publish.ts`: delete the local `Config` interface, `configPath`, `readConfig`, `writeConfig` (lines 53–73), and add:

```ts
import { readConfig, writeConfig, type AtrophyConfig } from "./config.js";
```

Rename remaining local uses of the `Config` type to `AtrophyConfig`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run cli/ && npm run typecheck`
Expected: PASS (publish.test.ts keeps passing — behavior is identical).

- [ ] **Step 5: Commit**

```bash
git add cli/config.ts cli/config.test.ts cli/publish.ts
git commit -m "refactor(cli): extract shared config module; add packs + packDirs()"
```

---

### Task 7: CLI — packs wiring, `parseLang`, baseline language filter

**Files:**
- Modify: `cli/index.ts` (bankDir → bankDirs at line 29; drill/baseline `-l` options at lines 328/347; `baseline()` at line 291; `dueAxis` at line 59)
- Modify: `engine/select.ts` (new `availableAxes`)
- Test: `engine/select.test.ts`

**Interfaces:**
- Consumes: `packDirs()` (Task 6), `loadBank(string[])` (Task 5).
- Produces: `availableAxes(bank: Exercise[], language?: Language): Axis[]` in `engine/select.ts`. `cli/index.ts` gains `bankDirs(): string[]` and `parseLang(value: string): Language`.

- [ ] **Step 1: Write the failing test**

Append to `engine/select.test.ts` (import `availableAxes` from `./select.js` and `AXES` from `../bank/schema.js`; build minimal exercises inline like the file's existing fixtures):

```ts
describe("availableAxes", () => {
  const mk = (axis: string, language: string) =>
    ({ ...( { id: `x-${axis}-${language}`, kind: "cloze", axis, language, tier: 1, title: "t", prompt: "p", softTimeLimitSeconds: 60, testTimeoutMs: 10_000, snippet: "____", acceptedAnswers: ["a"] } as unknown) }) as Exercise;
  const bank = [mk("api-memory", "java"), mk("code-reading", "python"), { ...(mk("decomposition", "any") as object), kind: "outline", rubric: ["r"] } as unknown as Exercise];
  it("filters axes by language, counting language-any exercises for every filter", () => {
    expect(availableAxes(bank, "java")).toEqual(["api-memory", "decomposition"]);
    expect(availableAxes(bank, "python")).toEqual(["code-reading", "decomposition"]);
    expect(availableAxes(bank)).toEqual(["code-reading", "api-memory", "decomposition"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run engine/select.test.ts -t "availableAxes"`
Expected: FAIL — `availableAxes` is not exported.

- [ ] **Step 3: Implement**

In `engine/select.ts` add (near `selectExercise`):

```ts
/** Axes that actually have content for the given language ("any" counts for every language). */
export function availableAxes(bank: Exercise[], language?: Language): Axis[] {
  return AXES.filter((axis) =>
    bank.some(
      (e) => e.axis === axis && (language === undefined || e.language === language || e.language === "any"),
    ),
  );
}
```

(`AXES` joins the existing `../bank/schema.js` import.)

In `cli/index.ts`:

1. Replace `bankDir()` with:

```ts
function bankDirs(): string[] {
  const base = (() => {
    if (process.env.ATROPHY_BANK) return process.env.ATROPHY_BANK;
    const candidates = [
      join(__dirname, "..", "bank", "exercises"), // tsx dev: cli/../bank
      join(__dirname, "..", "..", "bank", "exercises"), // built: dist/cli/../../bank
    ];
    const found = candidates.find((c) => existsSync(c));
    if (!found) throw new Error("exercise bank not found - set ATROPHY_BANK");
    return found;
  })();
  const packs = packDirs();
  for (const p of packs) {
    if (!existsSync(p)) {
      throw new Error(`pack directory not found: ${p} (check ATROPHY_PACKS / "packs" in ${configPath()})`);
    }
  }
  return [base, ...packs];
}
```

Import `configPath, packDirs` from `./config.js`. Replace every `loadBank(bankDir())` with `loadBank(bankDirs())`, and the `doctor` command's `bankDir()` fallback block with the same try/catch around `bankDirs()` (pass the array through — Task 13 updates `DoctorDeps`).

2. Add `parseLang` next to `parseAxis`:

```ts
function parseLang(value: string): Language {
  if (!(LANGUAGES as readonly string[]).includes(value)) {
    console.error(pc.red(`unknown language "${value}" - one of: ${LANGUAGES.join(", ")}`));
    process.exit(1);
  }
  return value as Language;
}
```

Import `LANGUAGES` from `../bank/schema.js`. In `drillOnce`, replace `const language = flags.lang as Language | undefined;` with `const language = flags.lang ? parseLang(flags.lang) : undefined;`.

3. Update both `-l, --lang` option help strings to `` `one of: ${LANGUAGES.join(", ")}` ``.

4. Fix the baseline filter (uses the new helper so `atrophy baseline -l java` only visits axes with java or language-any content):

```ts
async function baseline(store: Store, flags: DrillFlags): Promise<void> {
  const bank = loadBank(bankDirs());
  const language = flags.lang ? parseLang(flags.lang) : undefined;
  const axesWithExercises = availableAxes(bank, language);
  ...
}
```

Import `availableAxes` from `../engine/select.js`. Also swap `dueAxis`'s `AXES.filter(...)` body to `availableAxes(bank)` (same semantics, one source of truth).

- [ ] **Step 4: Run tests + smoke to verify**

Run: `npx vitest run engine/select.test.ts && npm run typecheck`
Expected: PASS.
Smoke: `$env:ATROPHY_DB="$env:TEMP\atrophy-dev.db"; $env:ATROPHY_NO_SYNC="1"; npm run dev -- drill --lang rust` → red `unknown language "rust" - one of: python, javascript, java`.

- [ ] **Step 5: Commit**

```bash
git add cli/index.ts engine/select.ts engine/select.test.ts
git commit -m "feat(cli): pack merging, --lang validation, baseline language filter"
```

---

### Task 8: Runner — win32 TEMP/TMP passthrough

**Files:**
- Modify: `engine/runner.ts` (env construction, line 33)
- Test: `engine/runner.test.ts` (create — the runner has no test file yet)

**Interfaces:**
- Produces: no API change; the minimal child env additionally contains `TEMP`/`TMP` on win32 (JVM temp-dir resolution needs them; without them `java.io.tmpdir` falls back to unwritable `C:\Windows`).

- [ ] **Step 1: Write the failing test**

Create `engine/runner.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { run } from "./runner.js";

describe("run env", () => {
  it("keeps the env minimal but passes TEMP/TMP through on Windows", async () => {
    const r = await run(process.execPath, ["-e", "console.log(JSON.stringify({ TEMP: process.env.TEMP ?? null, HOME: process.env.HOME ?? null, USERPROFILE: process.env.USERPROFILE ?? null }))"], {
      cwd: process.cwd(),
      timeoutMs: 15_000,
    });
    const env = JSON.parse(r.stdout.trim()) as { TEMP: string | null; HOME: string | null; USERPROFILE: string | null };
    expect(env.USERPROFILE).toBeNull(); // still minimal
    if (process.platform === "win32") {
      expect(env.TEMP).toBe(process.env.TEMP ?? null);
    } else {
      expect(env.TEMP).toBeNull();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run engine/runner.test.ts`
Expected: on Windows FAIL (`TEMP` is null); on non-Windows it passes — note that and proceed (CI's windows leg is the enforcement).

- [ ] **Step 3: Implement**

In `engine/runner.ts`, extend the env object:

```ts
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      // JVM (and others) resolve their temp dir from TEMP/TMP; without them Windows
      // falls back to C:\Windows, which is not writable for user processes.
      ...(process.platform === "win32" && process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
      ...(process.platform === "win32" && process.env.TMP ? { TMP: process.env.TMP } : {}),
      ...(process.env.PYTHONIOENCODING ? {} : { PYTHONIOENCODING: "utf-8" }),
      ...opts.env,
    };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run engine/runner.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add engine/runner.ts engine/runner.test.ts
git commit -m "fix(runner): pass TEMP/TMP through on win32 for JVM temp-dir resolution"
```

---

### Task 9: `engine/javatool.ts` — JDK discovery, flags, resource resolution

**Files:**
- Create: `engine/javatool.ts`
- Create: `engine/javatool.test.ts`

**Interfaces:**
- Produces (consumed by grader Tasks 10–11, doctor Task 13, tests Task 14):
  - `JAVA_RUNTIME_FLAGS: readonly string[]` = `["-Dfile.encoding=UTF-8", "-Duser.language=en", "-Duser.country=US", "-Duser.timezone=UTC"]`
  - `JAVA_COMPILE_TIMEOUT_MS = 30_000`, `MIN_JDK_MAJOR = 21`
  - `javaCommand(env?): string`, `javacCommand(env?): string` — `ATROPHY_JAVA_HOME/bin/<tool>[.exe]` else bare tool name
  - `javaResourceCandidates(): string[]`, `javaResourceDir(): string` (existsSync candidates, throw if none)
  - `hasJdk(): boolean` (cached spawnSync probe), `parseJavaMajor(s: string): number | null`
  - `missingJdkHint(cmd: string): string` — the friendly guidance string

- [ ] **Step 1: Write the failing tests**

Create `engine/javatool.test.ts`:

```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  JAVA_COMPILE_TIMEOUT_MS,
  JAVA_RUNTIME_FLAGS,
  javaCommand,
  javacCommand,
  javaResourceCandidates,
  missingJdkHint,
  parseJavaMajor,
} from "./javatool.js";

describe("jdk discovery", () => {
  it("uses bare tool names without ATROPHY_JAVA_HOME", () => {
    expect(javaCommand({})).toBe("java");
    expect(javacCommand({})).toBe("javac");
  });
  it("resolves bin/<tool> under ATROPHY_JAVA_HOME (with .exe on win32)", () => {
    const home = join("C:", "jdk-21");
    const suffix = process.platform === "win32" ? ".exe" : "";
    expect(javaCommand({ ATROPHY_JAVA_HOME: home })).toBe(join(home, "bin", `java${suffix}`));
    expect(javacCommand({ ATROPHY_JAVA_HOME: home })).toBe(join(home, "bin", `javac${suffix}`));
  });
});

describe("constants and helpers", () => {
  it("pins encoding, locale, and timezone", () => {
    expect(JAVA_RUNTIME_FLAGS).toEqual([
      "-Dfile.encoding=UTF-8",
      "-Duser.language=en",
      "-Duser.country=US",
      "-Duser.timezone=UTC",
    ]);
    expect(JAVA_COMPILE_TIMEOUT_MS).toBe(30_000);
  });
  it("parses javac/java version output", () => {
    expect(parseJavaMajor("javac 21.0.9")).toBe(21);
    expect(parseJavaMajor('openjdk version "21.0.9" 2025-10-21 LTS')).toBe(21);
    expect(parseJavaMajor("gibberish")).toBeNull();
  });
  it("resource candidates cover dev and built layouts, and one exists in dev", () => {
    const cands = javaResourceCandidates();
    expect(cands.some((c) => c.endsWith(join("engine", "java")))).toBe(true);
    expect(missingJdkHint("javac")).toMatch(/JDK.*21|ATROPHY_JAVA_HOME/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run engine/javatool.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `engine/javatool.ts`:

```ts
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Pinned JVM runtime flags: formatted output must not drift with the host's
 * locale or timezone, and file I/O is always UTF-8 (JEP 400 default is 18+,
 * but explicit beats implicit).
 */
export const JAVA_RUNTIME_FLAGS = [
  "-Dfile.encoding=UTF-8",
  "-Duser.language=en",
  "-Duser.country=US",
  "-Duser.timezone=UTC",
] as const;

/** Compile gets its own generous budget - compile time is not the user's fault. */
export const JAVA_COMPILE_TIMEOUT_MS = 30_000;

export const MIN_JDK_MAJOR = 21;

function jdkTool(tool: "java" | "javac", env: NodeJS.ProcessEnv): string {
  const home = env.ATROPHY_JAVA_HOME;
  if (!home) return tool;
  const suffix = process.platform === "win32" ? ".exe" : "";
  return join(home, "bin", `${tool}${suffix}`);
}

export function javaCommand(env: NodeJS.ProcessEnv = process.env): string {
  return jdkTool("java", env);
}

export function javacCommand(env: NodeJS.ProcessEnv = process.env): string {
  return jdkTool("javac", env);
}

export function missingJdkHint(cmd: string): string {
  return `${cmd} not found - Java drills need a JDK >= ${MIN_JDK_MAJOR} (Temurin recommended). Install one or set ATROPHY_JAVA_HOME.`;
}

/** "javac 21.0.9" or 'openjdk version "21.0.9" ...' -> 21 */
export function parseJavaMajor(versionOutput: string): number | null {
  const m = /(?:^|\s|")(\d+)\.\d+\.\d+/.exec(versionOutput);
  return m ? Number.parseInt(m[1]!, 10) : null;
}

/** Dev layout: engine/java next to this file. Built: dist/engine -> ../../engine/java. */
export function javaResourceCandidates(): string[] {
  return [join(__dirname, "java"), join(__dirname, "..", "..", "engine", "java")];
}

export function javaResourceDir(): string {
  const found = javaResourceCandidates().find((c) => existsSync(c));
  if (!found) throw new Error("engine/java resources not found - broken install? (npm files must include engine/java)");
  return found;
}

let jdkProbe: boolean | undefined;

/** One cached probe per process: is a runnable javac available? */
export function hasJdk(): boolean {
  if (jdkProbe === undefined) {
    try {
      jdkProbe = spawnSync(javacCommand(), ["-version"], { timeout: 10_000, windowsHide: true }).status === 0;
    } catch {
      jdkProbe = false;
    }
  }
  return jdkProbe;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run engine/javatool.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add engine/javatool.ts engine/javatool.test.ts
git commit -m "feat(engine): javatool - JDK discovery, pinned flags, resource resolution"
```

---

### Task 10: Java resources — `Harness.java` + `Atrophy.java` + packaging

**Files:**
- Create: `engine/java/Harness.java`
- Create: `engine/java/Atrophy.java`
- Modify: `package.json` (`files` array)
- Test: `engine/javatool.test.ts` (compile check, JDK-gated)

**Interfaces:**
- Produces: `Harness.java` — reads `tests.json` (`{"functionName": string, "tests": [{"args": [...], "expected": ...}]}`) from the working dir, invokes `Solution`, prints `ATROPHY_RESULT`. `Atrophy.java` — static helper: `Atrophy.plan(int)`, `Atrophy.check(String, boolean)`, `Atrophy.report()`, `Atrophy.watchdog(long)`. Both compiled per-drill in the scratch dir (Tasks 10–11).
- Number model: integer JSON literals → `Long`, else `Double`; serializer emits integral finite doubles |v| ≤ 2^53 as integers, `NaN`/`Infinity` as `null` (parity with `JSON.stringify`).
- Failure entries: `{index, args, expected, actual?}` or `{index, args, expected, error}`; top-level load errors use `index: -1`. Atrophy check failures use `{index, error}` only.

- [ ] **Step 1: Write the failing compile test**

Append to `engine/javatool.test.ts`:

```ts
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { run } from "./runner.js";
import { hasJdk, javaResourceDir } from "./javatool.js";

if (!hasJdk()) console.warn("⚠ JDK not found - Java resource compile test SKIPPED. Install JDK 21 to validate.");
describe.skipIf(!hasJdk())("java resources", () => {
  it("Harness.java and Atrophy.java compile cleanly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atrophy-javares-"));
    try {
      cpSync(javaResourceDir(), dir, { recursive: true });
      const r = await run(javacCommand(), ["-encoding", "UTF-8", "Harness.java", "Atrophy.java"], {
        cwd: dir,
        timeoutMs: JAVA_COMPILE_TIMEOUT_MS,
      });
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run engine/javatool.test.ts -t "resources"`
Expected: FAIL — `javaResourceDir()` throws (directory doesn't exist yet).

- [ ] **Step 3: Create `engine/java/Atrophy.java`**

```java
import java.util.ArrayList;
import java.util.List;

/**
 * Optional helper for exercise-supplied harnesses (testCode). Usage:
 *   Atrophy.plan(4);                       // declare totalChecks up front
 *   Atrophy.watchdog(20_000);              // deadlock insurance: report partial results
 *   Atrophy.check("writers exclusive", ok);
 *   Atrophy.report();                      // prints the ATROPHY_RESULT line (idempotent)
 * A harness may also print the marker line itself; this class is sugar, not magic.
 */
public final class Atrophy {
    private static final List<String> failures = new ArrayList<>();
    private static int planned = 0;
    private static int ran = 0;
    private static int passed = 0;
    private static boolean reported = false;

    private Atrophy() {}

    /** Declare how many checks this harness runs (must equal the exercise's totalChecks). */
    public static synchronized void plan(int totalChecks) {
        planned = totalChecks;
    }

    public static synchronized void check(String name, boolean ok) {
        ran++;
        if (ok) passed++;
        else failures.add(name);
    }

    /**
     * Print the result marker exactly once. Checks that never ran (deadlock, timeout)
     * are reported as failures so the declared total always matches.
     */
    public static synchronized void report() {
        if (reported) return;
        reported = true;
        int total = Math.max(planned, ran);
        for (int i = ran; i < total; i++) {
            failures.add("check not reached (deadlock or timeout?)");
        }
        StringBuilder sb = new StringBuilder("ATROPHY_RESULT {\"passed\":").append(passed)
                .append(",\"total\":").append(total).append(",\"failures\":[");
        for (int i = 0; i < failures.size(); i++) {
            if (i > 0) sb.append(',');
            sb.append("{\"index\":").append(i).append(",\"error\":\"").append(esc(failures.get(i))).append("\"}");
        }
        sb.append("]}");
        System.out.println(sb);
        System.out.flush();
    }

    /**
     * Start a daemon watchdog: if the harness has not reported after millis, print
     * partial results and halt the JVM (halt, not exit - deadlocked threads must not
     * block shutdown). Keep millis comfortably under the exercise's testTimeoutMs.
     */
    public static void watchdog(long millis) {
        Thread t = new Thread(() -> {
            try {
                Thread.sleep(millis);
            } catch (InterruptedException e) {
                return;
            }
            report();
            Runtime.getRuntime().halt(0);
        }, "atrophy-watchdog");
        t.setDaemon(true);
        t.start();
    }

    private static String esc(String s) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
                }
            }
        }
        return sb.toString();
    }
}
```

- [ ] **Step 4: Create `engine/java/Harness.java`**

```java
import java.lang.reflect.Array;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.reflect.ParameterizedType;
import java.lang.reflect.Type;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Generic grading harness for Java write/fix exercises. Reads tests.json
 * ({"functionName": ..., "tests": [{"args": [...], "expected": ...}]}) from the
 * working directory, invokes the named method on class Solution via reflection,
 * canonicalizes both sides to sorted-key JSON, and prints one line:
 *   ATROPHY_RESULT {"passed":N,"total":M,"failures":[...]}
 *
 * Number model (must match the Node harness's JSON.stringify semantics):
 *  - parse: integer literals that fit a long -> Long, everything else -> Double
 *  - serialize: Long as integer; finite integral Double with |v| <= 2^53 as integer;
 *    NaN/Infinity -> null
 *
 * Supported parameter/return types (anything else is a NAMED error, never a crash):
 *  int, long, double, boolean, char, String, Integer, Long, Double, Boolean, Character,
 *  int[], long[], double[], boolean[], String[], List<T> (T from generics), Map<String,T>, Object.
 */
public final class Harness {
    private static final int MAX_DEPTH = 64;

    public static void main(String[] args) throws Exception {
        Map<String, Object> spec = asMap(Json.parse(Files.readString(Path.of("tests.json"))));
        String functionName = (String) spec.get("functionName");
        List<Object> tests = asList(spec.get("tests"));
        int total = tests.size();

        Class<?> solutionClass;
        try {
            solutionClass = Class.forName("Solution");
        } catch (Throwable t) {
            emitLoadError(total, "could not load class Solution - keep `public class Solution` in the default package (no `package` line). " + t);
            return;
        }

        List<Map<String, Object>> failures = new ArrayList<>();
        int passed = 0;
        for (int i = 0; i < total; i++) {
            Map<String, Object> test = asMap(tests.get(i));
            List<Object> testArgs = asList(test.get("args"));
            Object expected = test.get("expected");
            Map<String, Object> failure = new TreeMap<>();
            failure.put("index", (long) i);
            failure.put("args", testArgs);
            failure.put("expected", expected);
            try {
                Method method = findMethod(solutionClass, functionName, testArgs.size());
                Object target = Modifier.isStatic(method.getModifiers()) ? null : solutionClass.getDeclaredConstructor().newInstance();
                Object[] coerced = new Object[testArgs.size()];
                Type[] generics = method.getGenericParameterTypes();
                for (int p = 0; p < coerced.length; p++) {
                    coerced[p] = coerce(testArgs.get(p), generics[p]);
                }
                Object actual = method.invoke(target, coerced);
                Object canonActual = canon(actual, 0);
                Object canonExpected = canon(expected, 0);
                if (Json.write(canonActual).equals(Json.write(canonExpected))) {
                    passed++;
                } else {
                    failure.put("actual", canonActual);
                    failures.add(failure);
                }
            } catch (InvocationTargetException e) {
                failure.put("error", describeThrowable(e.getCause() == null ? e : e.getCause()));
                failures.add(failure);
            } catch (HarnessProblem e) {
                failure.put("error", e.getMessage());
                failures.add(failure);
            } catch (Throwable t) {
                failure.put("error", describeThrowable(t));
                failures.add(failure);
            }
        }

        Map<String, Object> result = new TreeMap<>();
        result.put("passed", (long) passed);
        result.put("total", (long) total);
        result.put("failures", failures);
        System.out.println("ATROPHY_RESULT " + Json.write(result));
    }

    /** A named, user-readable grading problem (unsupported type, bad arity, ...). */
    private static final class HarnessProblem extends RuntimeException {
        HarnessProblem(String message) { super(message); }
    }

    private static void emitLoadError(int total, String message) {
        Map<String, Object> failure = new TreeMap<>();
        failure.put("index", -1L);
        failure.put("args", new ArrayList<>());
        failure.put("expected", null);
        failure.put("error", message);
        Map<String, Object> result = new TreeMap<>();
        result.put("passed", 0L);
        result.put("total", (long) total);
        result.put("failures", List.of(failure));
        System.out.println("ATROPHY_RESULT " + Json.write(result));
    }

    private static Method findMethod(Class<?> cls, String name, int arity) {
        List<Method> nameMatches = new ArrayList<>();
        for (Method m : cls.getMethods()) {
            if (m.getName().equals(name)) nameMatches.add(m);
        }
        if (nameMatches.isEmpty()) {
            throw new HarnessProblem("no public method named `" + name + "` on Solution - keep the starter signature");
        }
        List<Method> arityMatches = new ArrayList<>();
        for (Method m : nameMatches) {
            if (m.getParameterCount() == arity) arityMatches.add(m);
        }
        if (arityMatches.isEmpty()) {
            throw new HarnessProblem("`" + name + "` exists but no overload takes " + arity + " argument(s)");
        }
        if (arityMatches.size() > 1) {
            throw new HarnessProblem("`" + name + "` has " + arityMatches.size() + " overloads with " + arity + " parameter(s) - overloads are not supported");
        }
        return arityMatches.get(0);
    }

    // ---------- coercion: parsed JSON -> declared parameter type ----------

    private static Object coerce(Object v, Type type) {
        Class<?> raw = rawClass(type);
        if (raw == Object.class) return v;
        if (v == null) {
            if (raw.isPrimitive()) throw new HarnessProblem("test passes null into primitive " + raw.getName());
            return null;
        }
        if (raw == int.class || raw == Integer.class) return (int) requireIntegral(v, "int");
        if (raw == long.class || raw == Long.class) return requireIntegral(v, "long");
        if (raw == double.class || raw == Double.class) {
            if (v instanceof Number n) return n.doubleValue();
            throw new HarnessProblem("cannot coerce " + typeName(v) + " to double");
        }
        if (raw == boolean.class || raw == Boolean.class) {
            if (v instanceof Boolean b) return b;
            throw new HarnessProblem("cannot coerce " + typeName(v) + " to boolean");
        }
        if (raw == char.class || raw == Character.class) {
            if (v instanceof String s && s.length() == 1) return s.charAt(0);
            throw new HarnessProblem("char parameters take a 1-character string, got " + typeName(v));
        }
        if (raw == String.class) {
            if (v instanceof String s) return s;
            throw new HarnessProblem("cannot coerce " + typeName(v) + " to String");
        }
        if (raw.isArray()) {
            if (!(v instanceof List<?> list)) throw new HarnessProblem("cannot coerce " + typeName(v) + " to " + raw.getSimpleName());
            Class<?> component = raw.getComponentType();
            Object arr = Array.newInstance(component, list.size());
            for (int i = 0; i < list.size(); i++) {
                Array.set(arr, i, coerce(list.get(i), component));
            }
            return arr;
        }
        if (List.class.isAssignableFrom(raw)) {
            if (!(v instanceof List<?> list)) throw new HarnessProblem("cannot coerce " + typeName(v) + " to List");
            Type elem = typeArg(type, 0);
            List<Object> out = new ArrayList<>(list.size());
            for (Object item : list) out.add(elem == null ? item : coerce(item, elem));
            return out;
        }
        if (Map.class.isAssignableFrom(raw)) {
            if (!(v instanceof Map<?, ?> map)) throw new HarnessProblem("cannot coerce " + typeName(v) + " to Map");
            Type valType = typeArg(type, 1);
            Map<String, Object> out = new LinkedHashMap<>();
            for (Map.Entry<?, ?> e : map.entrySet()) {
                out.put(String.valueOf(e.getKey()), valType == null ? e.getValue() : coerce(e.getValue(), valType));
            }
            return out;
        }
        throw new HarnessProblem("unsupported parameter type " + raw.getName() + " (supported: primitives, String, arrays, List, Map, Object)");
    }

    private static long requireIntegral(Object v, String target) {
        if (v instanceof Long l) return l;
        if (v instanceof Double d && d == Math.rint(d) && !d.isInfinite()) return (long) (double) d;
        throw new HarnessProblem("cannot coerce " + (v instanceof Number ? String.valueOf(v) : typeName(v)) + " to " + target);
    }

    private static Class<?> rawClass(Type type) {
        if (type instanceof Class<?> c) return c;
        if (type instanceof ParameterizedType p && p.getRawType() instanceof Class<?> c) return c;
        throw new HarnessProblem("unsupported parameter type " + type);
    }

    private static Type typeArg(Type type, int index) {
        if (type instanceof ParameterizedType p && p.getActualTypeArguments().length > index) {
            return p.getActualTypeArguments()[index];
        }
        return null;
    }

    // ---------- canonicalization: return value -> JSON-ready structure ----------

    private static Object canon(Object v, int depth) {
        if (depth > MAX_DEPTH) throw new HarnessProblem("return value nests deeper than " + MAX_DEPTH + " levels (cycle?)");
        if (v == null || v instanceof Boolean || v instanceof String) return v;
        if (v instanceof Character c) return String.valueOf(c);
        if (v instanceof Long || v instanceof Integer || v instanceof Short || v instanceof Byte) {
            return ((Number) v).longValue();
        }
        if (v instanceof Double || v instanceof Float) return ((Number) v).doubleValue();
        if (v.getClass().isArray()) {
            int n = Array.getLength(v);
            List<Object> out = new ArrayList<>(n);
            for (int i = 0; i < n; i++) out.add(canon(Array.get(v, i), depth + 1));
            return out;
        }
        if (v instanceof Collection<?> col) {
            List<Object> out = new ArrayList<>(col.size());
            for (Object item : col) out.add(canon(item, depth + 1));
            return out;
        }
        if (v instanceof Map<?, ?> map) {
            Map<String, Object> out = new TreeMap<>();
            for (Map.Entry<?, ?> e : map.entrySet()) out.put(String.valueOf(e.getKey()), canon(e.getValue(), depth + 1));
            return out;
        }
        throw new HarnessProblem("unsupported return type " + v.getClass().getName() + " (return primitives, String, arrays, List, or Map)");
    }

    private static String typeName(Object v) {
        return v == null ? "null" : v.getClass().getSimpleName();
    }

    private static String describeThrowable(Throwable t) {
        StringBuilder sb = new StringBuilder(t.toString());
        StackTraceElement[] trace = t.getStackTrace();
        for (int i = 0; i < Math.min(2, trace.length); i++) sb.append("\n  at ").append(trace[i]);
        return sb.toString();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asMap(Object v) {
        return (Map<String, Object>) v;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> asList(Object v) {
        return (List<Object>) v;
    }

    // ---------- minimal JSON: parse to Map/List/String/Long/Double/Boolean/null ----------

    static final class Json {
        private final String src;
        private int pos;

        private Json(String src) { this.src = src; }

        static Object parse(String src) {
            Json j = new Json(src);
            Object v = j.value();
            j.ws();
            if (j.pos != src.length()) throw new IllegalArgumentException("trailing JSON at " + j.pos);
            return v;
        }

        private Object value() {
            ws();
            char c = peek();
            if (c == '{') return object();
            if (c == '[') return array();
            if (c == '"') return string();
            if (c == 't') { expect("true"); return Boolean.TRUE; }
            if (c == 'f') { expect("false"); return Boolean.FALSE; }
            if (c == 'n') { expect("null"); return null; }
            return number();
        }

        private Map<String, Object> object() {
            Map<String, Object> out = new LinkedHashMap<>();
            pos++; // {
            ws();
            if (peek() == '}') { pos++; return out; }
            while (true) {
                ws();
                String key = string();
                ws();
                if (src.charAt(pos++) != ':') throw new IllegalArgumentException("expected : at " + (pos - 1));
                out.put(key, value());
                ws();
                char c = src.charAt(pos++);
                if (c == '}') return out;
                if (c != ',') throw new IllegalArgumentException("expected , or } at " + (pos - 1));
            }
        }

        private List<Object> array() {
            List<Object> out = new ArrayList<>();
            pos++; // [
            ws();
            if (peek() == ']') { pos++; return out; }
            while (true) {
                out.add(value());
                ws();
                char c = src.charAt(pos++);
                if (c == ']') return out;
                if (c != ',') throw new IllegalArgumentException("expected , or ] at " + (pos - 1));
            }
        }

        private String string() {
            if (src.charAt(pos++) != '"') throw new IllegalArgumentException("expected string at " + (pos - 1));
            StringBuilder sb = new StringBuilder();
            while (true) {
                char c = src.charAt(pos++);
                if (c == '"') return sb.toString();
                if (c == '\\') {
                    char e = src.charAt(pos++);
                    switch (e) {
                        case '"' -> sb.append('"');
                        case '\\' -> sb.append('\\');
                        case '/' -> sb.append('/');
                        case 'b' -> sb.append('\b');
                        case 'f' -> sb.append('\f');
                        case 'n' -> sb.append('\n');
                        case 'r' -> sb.append('\r');
                        case 't' -> sb.append('\t');
                        case 'u' -> { sb.append((char) Integer.parseInt(src.substring(pos, pos + 4), 16)); pos += 4; }
                        default -> throw new IllegalArgumentException("bad escape \\" + e);
                    }
                } else {
                    sb.append(c);
                }
            }
        }

        private Object number() {
            int start = pos;
            if (peek() == '-') pos++;
            boolean fractional = false;
            while (pos < src.length()) {
                char c = src.charAt(pos);
                if (c >= '0' && c <= '9') pos++;
                else if (c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') { fractional = fractional || c == '.' || c == 'e' || c == 'E'; pos++; }
                else break;
            }
            String text = src.substring(start, pos);
            if (!fractional) {
                try {
                    return Long.parseLong(text);
                } catch (NumberFormatException ignored) {
                    // falls through to Double for out-of-range integers
                }
            }
            return Double.parseDouble(text);
        }

        private void ws() {
            while (pos < src.length() && Character.isWhitespace(src.charAt(pos))) pos++;
        }

        private char peek() {
            if (pos >= src.length()) throw new IllegalArgumentException("unexpected end of JSON");
            return src.charAt(pos);
        }

        private void expect(String word) {
            if (!src.startsWith(word, pos)) throw new IllegalArgumentException("bad literal at " + pos);
            pos += word.length();
        }

        static String write(Object v) {
            StringBuilder sb = new StringBuilder();
            writeValue(v, sb);
            return sb.toString();
        }

        private static void writeValue(Object v, StringBuilder sb) {
            if (v == null) { sb.append("null"); return; }
            if (v instanceof String s) { writeString(s, sb); return; }
            if (v instanceof Boolean b) { sb.append(b); return; }
            if (v instanceof Long l) { sb.append((long) l); return; }
            if (v instanceof Double d) { writeDouble(d, sb); return; }
            if (v instanceof List<?> list) {
                sb.append('[');
                for (int i = 0; i < list.size(); i++) {
                    if (i > 0) sb.append(',');
                    writeValue(list.get(i), sb);
                }
                sb.append(']');
                return;
            }
            if (v instanceof Map<?, ?> map) {
                TreeMap<String, Object> sorted = new TreeMap<>();
                for (Map.Entry<?, ?> e : map.entrySet()) sorted.put(String.valueOf(e.getKey()), e.getValue());
                sb.append('{');
                boolean first = true;
                for (Map.Entry<String, Object> e : sorted.entrySet()) {
                    if (!first) sb.append(',');
                    first = false;
                    writeString(e.getKey(), sb);
                    sb.append(':');
                    writeValue(e.getValue(), sb);
                }
                sb.append('}');
                return;
            }
            throw new IllegalArgumentException("cannot serialize " + v.getClass().getName());
        }

        /** Integral finite doubles up to 2^53 print as integers - JSON.stringify parity. */
        private static void writeDouble(double d, StringBuilder sb) {
            if (Double.isNaN(d) || Double.isInfinite(d)) { sb.append("null"); return; }
            if (d == Math.rint(d) && Math.abs(d) <= 9007199254740992.0) { sb.append((long) d); return; }
            sb.append(d);
        }

        private static void writeString(String s, StringBuilder sb) {
            sb.append('"');
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                switch (c) {
                    case '"' -> sb.append("\\\"");
                    case '\\' -> sb.append("\\\\");
                    case '\n' -> sb.append("\\n");
                    case '\r' -> sb.append("\\r");
                    case '\t' -> sb.append("\\t");
                    default -> {
                        if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                        else sb.append(c);
                    }
                }
            }
            sb.append('"');
        }
    }
}
```

In `package.json`, extend `files`:

```json
  "files": [
    "dist",
    "bank/exercises",
    "dashboard/index.html",
    "docs/research.md",
    "engine/java"
  ],
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run engine/javatool.test.ts && npm run typecheck`
Expected: PASS — both Java files compile with empty stderr.

- [ ] **Step 6: Commit**

```bash
git add engine/java/Harness.java engine/java/Atrophy.java engine/javatool.test.ts package.json
git commit -m "feat(engine): Java reflection harness + Atrophy testCode helper resources"
```

---

### Task 11: Grader — Java json-tests path

**Files:**
- Modify: `engine/grader.ts` (`solutionFileName` line 29, `grade` line 127)
- Test: `engine/grader.test.ts`

**Interfaces:**
- Consumes: Task 9 (`javaCommand`, `javacCommand`, `JAVA_RUNTIME_FLAGS`, `JAVA_COMPILE_TIMEOUT_MS`, `javaResourceDir`, `missingJdkHint`), Task 10 resources.
- Produces: `grade(ex, dir)` handles `language === "java"` for write/fix. `solutionFileName` returns `"Solution.java"` for java. Compile failures → `harnessError` starting with `javac:`.

- [ ] **Step 1: Write the failing tests**

Append to `engine/grader.test.ts`:

```ts
import { JAVA_COMPILE_TIMEOUT_MS, hasJdk } from "./javatool.js";

const javaEx: CodeExercise = {
  id: "sr-java-901",
  kind: "write",
  axis: "syntax-recall",
  language: "java",
  tier: 1,
  title: "double",
  prompt: "double it",
  functionName: "twice",
  starterCode: "public class Solution {\n    static int twice(int x) {\n        throw new UnsupportedOperationException(\"implement me\");\n    }\n}\n",
  softTimeLimitSeconds: 300,
  testTimeoutMs: 30_000,
  tests: [
    { args: [2], expected: 4 },
    { args: [-1], expected: -2 },
    { args: [0], expected: 0 },
  ],
};

if (!hasJdk()) console.warn("⚠ JDK not found - Java grader tests SKIPPED. Install JDK 21 to validate Java grading.");
describe.skipIf(!hasJdk())("grade - java", () => {
  it("passes a correct solution", async () => {
    const dir = scratch();
    writeSolution(dir, javaEx, "public class Solution {\n    static int twice(int x) { return x * 2; }\n}\n");
    const r = await grade(javaEx, dir);
    expect(r.harnessError).toBeUndefined();
    expect(r.passed).toBe(3);
    expect(r.total).toBe(3);
  }, 60_000);

  it("reports per-test failures with expected vs actual", async () => {
    const dir = scratch();
    writeSolution(dir, javaEx, "public class Solution {\n    static int twice(int x) { return x + 2; }\n}\n");
    const r = await grade(javaEx, dir);
    expect(r.passed).toBe(1);
    expect(r.failures.length).toBe(2);
    expect(r.failures[0]?.expected).toBe(-2);
    expect(r.failures[0]?.actual).toBe(1);
  }, 60_000);

  it("surfaces compile errors as harnessError with javac output", async () => {
    const dir = scratch();
    writeSolution(dir, javaEx, "public class Solution { static int twice(int x) { return }\n");
    const r = await grade(javaEx, dir);
    expect(r.passed).toBe(0);
    expect(r.harnessError).toMatch(/javac:/);
    expect(r.harnessError).toMatch(/error/i);
  }, 60_000);

  it("names the problem when the method is missing", async () => {
    const dir = scratch();
    writeSolution(dir, javaEx, "public class Solution { static int other(int x) { return x; } }\n");
    const r = await grade(javaEx, dir);
    expect(r.failures[0]?.error).toMatch(/no public method named `twice`/);
  }, 60_000);

  it("kills infinite loops via the hard timeout", async () => {
    const dir = scratch();
    writeSolution(dir, javaEx, "public class Solution {\n    static int twice(int x) { while (true) {} }\n}\n");
    const fast = { ...javaEx, testTimeoutMs: 5000 };
    const r = await grade(fast, dir);
    expect(r.passed).toBe(0);
    expect(r.harnessError).toMatch(/timed out/);
  }, 90_000);
});

describe.skipIf(!hasJdk())("grade - java type matrix", () => {
  const matrix: CodeExercise = {
    ...javaEx,
    id: "sr-java-902",
    functionName: "probe",
    starterCode: "x",
    tests: [],
  };
  async function gradeWith(solution: string, tests: CodeExercise["tests"]): Promise<ReturnType<typeof grade> extends Promise<infer R> ? R : never> {
    const dir = scratch();
    const ex = { ...matrix, tests };
    writeSolution(dir, ex, solution);
    return grade(ex, dir);
  }

  it("coerces int[] and returns arrays as lists", async () => {
    const r = await gradeWith(
      "public class Solution { static int[] probe(int[] xs) { int[] out = new int[xs.length]; for (int i = 0; i < xs.length; i++) out[i] = xs[i] * 2; return out; } }",
      [{ args: [[1, 2, 3]], expected: [2, 4, 6] }],
    );
    expect(r.passed).toBe(1);
  }, 60_000);

  it("coerces List<Integer> via generics (elements are Integer, not Double)", async () => {
    const r = await gradeWith(
      "import java.util.List;\npublic class Solution { static int probe(List<Integer> xs) { int s = 0; for (int x : xs) s += x; return s; } }",
      [{ args: [[1, 2, 3]], expected: 6 }],
    );
    expect(r.passed).toBe(1);
  }, 60_000);

  it("treats 2.0 and 2 as equal (number model)", async () => {
    const r = await gradeWith(
      "public class Solution { static double probe(int x) { return x * 1.0; } }",
      [{ args: [2], expected: 2 }],
    );
    expect(r.passed).toBe(1);
  }, 60_000);

  it("supports Map returns with sorted keys and instance methods", async () => {
    const r = await gradeWith(
      "import java.util.Map;\nimport java.util.HashMap;\npublic class Solution { Map<String, Integer> probe(String k) { Map<String, Integer> m = new HashMap<>(); m.put(k, 1); m.put(\"a\", 2); return m; } }",
      [{ args: ["z"], expected: { a: 2, z: 1 } }],
    );
    expect(r.passed).toBe(1);
  }, 60_000);

  it("accepts char params as 1-char strings; names overload ambiguity", async () => {
    const ok = await gradeWith(
      "public class Solution { static String probe(char c) { return String.valueOf(c) + c; } }",
      [{ args: ["x"], expected: "xx" }],
    );
    expect(ok.passed).toBe(1);
    const overloaded = await gradeWith(
      "public class Solution { static int probe(int x) { return x; } static int probe(String s) { return 0; } }",
      [{ args: [1], expected: 1 }],
    );
    expect(overloaded.failures[0]?.error).toMatch(/overloads are not supported/);
  }, 60_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run engine/grader.test.ts -t "java"`
Expected: FAIL — `grade` writes a `.py`/`.cjs` harness for java (`isPy` is false → node path) and node cannot parse `Solution.java`.

- [ ] **Step 3: Implement**

In `engine/grader.ts`:

1. Imports: add `copyFileSync` to the `node:fs` import; add:

```ts
import type { CodeLikeExercise, HarnessExercise } from "../bank/schema.js";
import { run, type RunResult } from "./runner.js";
import {
  JAVA_COMPILE_TIMEOUT_MS,
  JAVA_RUNTIME_FLAGS,
  javaCommand,
  javacCommand,
  javaResourceDir,
  missingJdkHint,
} from "./javatool.js";
```

2. `solutionFileName` gains java (and, ahead of Task 12, harness kinds — they're java by schema):

```ts
export function solutionFileName(ex: CodeLikeExercise | OutlineExercise): string {
  if (ex.kind === "outline") return "outline.md";
  if (ex.language === "java") return "Solution.java";
  return ex.language === "python" ? "solution.py" : "solution.js";
}
```

3. Extract the marker-parsing tail of `grade` (timeout check, marker scan, fallback error) into a shared helper so java reuses it verbatim:

```ts
function parseMarker(result: RunResult, total: number, timeoutMs: number): GradeResult {
  if (result.timedOut) {
    return { passed: 0, total, failures: [], harnessError: `tests timed out after ${timeoutMs} ms (infinite loop?)` };
  }
  const line = result.stdout.split(/\r?\n/).reverse().find((l) => l.startsWith(RESULT_MARKER));
  if (!line) {
    const detail = (result.stderr || result.stdout).trim().slice(0, 2000);
    return { passed: 0, total, failures: [], harnessError: detail || `harness produced no result (exit ${result.exitCode})` };
  }
  return JSON.parse(line.slice(RESULT_MARKER.length)) as GradeResult;
}
```

Rewrite the existing `grade` body to end with `return parseMarker(result, ex.tests.length, ex.testTimeoutMs);` (behavior identical).

4. Add the shared Java compile+run helper and the json-tests path:

```ts
/** javac + java with friendly errors; returns a GradeResult on failure, or the run result. */
async function compileAndRunJava(
  dir: string,
  sources: string[],
  mainClass: string,
  total: number,
  timeoutMs: number,
): Promise<{ error: GradeResult } | { result: RunResult }> {
  let compile;
  try {
    compile = await run(javacCommand(), ["-encoding", "UTF-8", ...sources], { cwd: dir, timeoutMs: JAVA_COMPILE_TIMEOUT_MS });
  } catch (err) {
    return { error: { passed: 0, total, failures: [], harnessError: missingJdkHint(javacCommand()) + ` (${(err as Error).message})` } };
  }
  if (compile.timedOut) {
    return { error: { passed: 0, total, failures: [], harnessError: `javac timed out after ${JAVA_COMPILE_TIMEOUT_MS} ms` } };
  }
  if (compile.exitCode !== 0) {
    return { error: { passed: 0, total, failures: [], harnessError: `javac: ${compile.stderr.trim().slice(0, 2000)}` } };
  }
  let result;
  try {
    result = await run(javaCommand(), [...JAVA_RUNTIME_FLAGS, mainClass], { cwd: dir, timeoutMs });
  } catch (err) {
    return { error: { passed: 0, total, failures: [], harnessError: missingJdkHint(javaCommand()) + ` (${(err as Error).message})` } };
  }
  return { result };
}

async function gradeJavaTests(ex: CodeExercise, dir: string): Promise<GradeResult> {
  copyFileSync(join(javaResourceDir(), "Harness.java"), join(dir, "Harness.java"));
  writeFileSync(join(dir, "tests.json"), JSON.stringify({ functionName: ex.functionName, tests: ex.tests }), "utf8");
  const total = ex.tests.length;
  const outcome = await compileAndRunJava(dir, ["Solution.java", "Harness.java"], "Harness", total, ex.testTimeoutMs);
  if ("error" in outcome) return outcome.error;
  return parseMarker(outcome.result, total, ex.testTimeoutMs);
}
```

5. Dispatch at the top of `grade`:

```ts
export async function grade(ex: CodeExercise, dir: string): Promise<GradeResult> {
  if (ex.language === "java") return gradeJavaTests(ex, dir);
  ...existing python/node body...
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run engine/grader.test.ts && npm run typecheck`
Expected: PASS — all java suites green, existing python/js suites untouched.

- [ ] **Step 5: Commit**

```bash
git add engine/grader.ts engine/grader.test.ts
git commit -m "feat(grader): java write/fix grading via reflection harness"
```

---

### Task 12: Grader + scoring + session — testCode path, clamp, failure rendering

**Files:**
- Modify: `engine/grader.ts` (grade dispatch + `gradeHarness`; `TestFailure.args/expected` become optional)
- Modify: `engine/scoring.ts` (`exerciseScore`, line 47)
- Modify: `engine/session.ts` (`runDrill` switch line 46, `codeDrill` param type, `buildSolutionFile` task line, `printFailures` line 210, `previewExercise`)
- Test: `engine/grader.test.ts`, `engine/scoring.test.ts`

**Interfaces:**
- Consumes: `HarnessExercise`, `isHarness` (Task 3); `compileAndRunJava`, `parseMarker` (Task 11); `Atrophy.java` (Task 10).
- Produces: `grade(ex: CodeLikeExercise, dir)` — harness kinds compile `Solution.java + Harness.java + Atrophy.java` and enforce `reported total === totalChecks`. `TestFailure` gains optional `args`/`expected`. `exerciseScore` clamps correctness. `codeDrill` accepts harness kinds; whiteboard (`submitPolicy: "single"`) grades exactly once.

- [ ] **Step 1: Write the failing tests**

Append to `engine/scoring.test.ts`:

```ts
describe("exerciseScore clamp", () => {
  it("never exceeds 1 even if passed > total (defense against buggy pack harnesses)", () => {
    expect(exerciseScore(7, 5, 10, 300)).toBe(1);
    expect(exerciseScore(-1, 5, 10, 300)).toBe(0);
  });
});
```

Append to `engine/grader.test.ts`:

```ts
import type { HarnessExercise } from "../bank/schema.js";

const harnessEx: HarnessExercise = {
  id: "conc-java-901",
  kind: "write-harness",
  axis: "syntax-recall",
  language: "java",
  tier: 3,
  title: "counter",
  prompt: "Make Counter.increment() thread-safe.",
  softTimeLimitSeconds: 600,
  testTimeoutMs: 30_000,
  totalChecks: 2,
  starterCode: "public class Solution {\n    private int n = 0;\n    public void increment() { n++; }\n    public int value() { return n; }\n}\n",
  testCode: `public class Harness {
    public static void main(String[] args) throws Exception {
        Atrophy.plan(2);
        Atrophy.watchdog(20_000);
        Solution s = new Solution();
        Thread[] ts = new Thread[4];
        for (int i = 0; i < 4; i++) {
            ts[i] = new Thread(() -> { for (int k = 0; k < 25_000; k++) s.increment(); });
        }
        for (Thread t : ts) t.start();
        for (Thread t : ts) t.join();
        Atrophy.check("100k increments survive 4 threads", s.value() == 100_000);
        Atrophy.check("value() is non-negative", s.value() >= 0);
        Atrophy.report();
    }
}`,
};

describe.skipIf(!hasJdk())("grade - java testCode", () => {
  it("grades a correct solution via the exercise's own harness", async () => {
    const dir = scratch();
    writeSolution(dir, harnessEx, "public class Solution {\n    private int n = 0;\n    public synchronized void increment() { n++; }\n    public synchronized int value() { return n; }\n}\n");
    const r = await grade(harnessEx, dir);
    expect(r.harnessError).toBeUndefined();
    expect(r.passed).toBe(2);
    expect(r.total).toBe(2);
  }, 90_000);

  it("fails the racy starter deterministically-shaped output (named check failures)", async () => {
    const dir = scratch();
    writeSolution(dir, harnessEx, harnessEx.starterCode);
    const r = await grade(harnessEx, dir);
    // the unsynchronized starter may occasionally pass the race by luck; the shape is what we assert
    expect(r.total).toBe(2);
    for (const f of r.failures) {
      expect(f.error).toBeTruthy();
      expect(f.args).toBeUndefined();
    }
  }, 90_000);

  it("rejects a harness whose reported total differs from totalChecks", async () => {
    const dir = scratch();
    const lying: HarnessExercise = {
      ...harnessEx,
      id: "conc-java-902",
      testCode: 'public class Harness { public static void main(String[] a) { System.out.println("ATROPHY_RESULT {\\"passed\\":7,\\"total\\":7,\\"failures\\":[]}"); } }',
    };
    writeSolution(dir, lying, lying.starterCode);
    const r = await grade(lying, dir);
    expect(r.harnessError).toMatch(/reported 7 checks but the exercise declares 2/);
    expect(r.passed).toBe(0);
  }, 90_000);

  it("scores a deadlocked solution 0 with named failures via the watchdog", async () => {
    const dir = scratch();
    const deadlockEx: HarnessExercise = { ...harnessEx, id: "conc-java-903", testTimeoutMs: 60_000 };
    writeSolution(dir, deadlockEx, "public class Solution {\n    public synchronized void increment() { while (true) {} }\n    public int value() { return 0; }\n}\n");
    const r = await grade(deadlockEx, dir);
    expect(r.harnessError).toBeUndefined(); // watchdog reported before the external timeout
    expect(r.passed).toBe(0);
    expect(r.total).toBe(2);
    expect(r.failures.some((f) => /not reached|deadlock/i.test(f.error ?? ""))).toBe(true);
  }, 120_000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run engine/scoring.test.ts -t clamp` → FAIL (`1.4` instead of `1`).
Run: `npx vitest run engine/grader.test.ts -t "testCode"` → FAIL (`grade` doesn't accept harness kinds — type error / wrong path).

- [ ] **Step 3: Implement**

`engine/scoring.ts` — clamp correctness in `exerciseScore`:

```ts
export function exerciseScore(
  passed: number,
  total: number,
  elapsedSeconds: number,
  softLimitSeconds: number,
): number {
  if (total <= 0) return 0;
  const correctness = Math.min(1, Math.max(0, passed / total));
  return correctness * timeFactor(elapsedSeconds, softLimitSeconds);
}
```

`engine/grader.ts`:

1. `TestFailure` — args/expected optional (Atrophy check failures have neither):

```ts
export interface TestFailure {
  index: number;
  args?: unknown[];
  expected?: unknown;
  actual?: unknown;
  error?: string;
}
```

2. Add the testCode path + widen `grade`:

```ts
async function gradeHarness(ex: HarnessExercise, dir: string): Promise<GradeResult> {
  writeFileSync(join(dir, "Harness.java"), ex.testCode, "utf8");
  copyFileSync(join(javaResourceDir(), "Atrophy.java"), join(dir, "Atrophy.java"));
  const total = ex.totalChecks;
  const outcome = await compileAndRunJava(dir, ["Solution.java", "Harness.java", "Atrophy.java"], "Harness", total, ex.testTimeoutMs);
  if ("error" in outcome) return outcome.error;
  const parsed = parseMarker(outcome.result, total, ex.testTimeoutMs);
  if (!parsed.harnessError && parsed.total !== ex.totalChecks) {
    return {
      passed: 0,
      total,
      failures: [],
      harnessError: `exercise bug: harness reported ${parsed.total} checks but the exercise declares ${ex.totalChecks} - please report this exercise`,
    };
  }
  return parsed;
}

export async function grade(ex: CodeLikeExercise, dir: string): Promise<GradeResult> {
  if (ex.kind === "write-harness" || ex.kind === "fix-harness") return gradeHarness(ex, dir);
  if (ex.language === "java") return gradeJavaTests(ex, dir);
  ...existing python/node body...
}
```

`engine/session.ts`:

1. `runDrill` switch — route harness kinds to `codeDrill`:

```ts
    case "write":
    case "fix":
    case "write-harness":
    case "fix-harness":
      return codeDrill(ex, solutionOverride);
```

2. Widen `codeDrill(ex: CodeLikeExercise, ...)`, `buildSolutionFile(ex: CodeLikeExercise)`, `commentPrefix(ex: CodeLikeExercise)` (java is `//` — the existing non-python branch already returns `//`). In `buildSolutionFile`, the task line becomes:

```ts
  const task = ex.kind === "fix" || ex.kind === "fix-harness" ? "Find and fix the bug below" : ex.title;
```

3. Whiteboard: inside `codeDrill`'s submit loop, immediately after `const result = await grade(ex, dir);` and `const passed = ...`, add:

```ts
        if (ex.submitPolicy === "single") {
          if (passed === result.total) {
            console.log(pc.green(`\n✓ ${passed}/${result.total} tests passed`) + pc.dim(` in ${Math.round(elapsed())}s`));
          } else {
            console.log(pc.red(`\n${passed}/${result.total} tests passed.`) + pc.dim("  whiteboard mode: single submission, no retries"));
            printFailures(result);
          }
          return makeOutcome(ex, passed, elapsed());
        }
```

4. `printFailures` — render arg-less (testCode) failures by their error text; insert at the top of the `for` loop:

```ts
    if (f.args === undefined) {
      console.log(pc.red(`\n✗ ${f.error ?? "check failed"}`));
      continue;
    }
```

5. `previewExercise` — harness kinds show starter code (extend the `case "write": case "fix":` group with `case "write-harness": case "fix-harness":`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run engine/ && npm run typecheck`
Expected: PASS (scoring clamp, all four testCode tests, existing suites).

- [ ] **Step 5: Commit**

```bash
git add engine/grader.ts engine/scoring.ts engine/session.ts engine/grader.test.ts engine/scoring.test.ts
git commit -m "feat(engine): testCode grading with totalChecks enforcement, score clamp, whiteboard mode"
```

---

### Task 13: Grader + session — java predict-output and recall

**Files:**
- Modify: `engine/grader.ts` (`gradePrediction` line 205; new `normalizeRecallAnswer`, `gradeRecall`)
- Modify: `engine/session.ts` (`runDrill` switch, new `recallDrill`, `previewExercise` case)
- Test: `engine/grader.test.ts`, `engine/session.test.ts` (create)

**Interfaces:**
- Consumes: `RecallExercise` (Task 2), `javaCommand`/`JAVA_RUNTIME_FLAGS` (Task 9).
- Produces: `gradePrediction` handles java via the source launcher (`java <flags> Main.java`). `normalizeRecallAnswer(s: string): { num?: number; text: string }` and `gradeRecall(ex: RecallExercise, answer: string): boolean` exported from grader. `recallDrill` in session (interactive + `--solution` first-line override, prints `reveal` after grading).

- [ ] **Step 1: Write the failing tests**

Append to `engine/grader.test.ts`:

```ts
import { gradeRecall, normalizeRecallAnswer } from "./grader.js";
import type { PredictExercise, RecallExercise } from "../bank/schema.js";

describe("recall grading (pure, no JDK needed)", () => {
  const recallEx: RecallExercise = {
    id: "rec-any-901",
    kind: "recall",
    axis: "decomposition",
    language: "any",
    tier: 1,
    title: "coin",
    prompt: "Probability of two heads in two fair flips?",
    softTimeLimitSeconds: 120,
    testTimeoutMs: 10_000,
    acceptedAnswers: ["1/4"],
    reveal: "2 independent halves multiply.",
  };
  it("accepts 1/4, 0.25, 25%, and ' .25 ' as the same number", () => {
    for (const answer of ["1/4", "0.25", "25%", " .25 ", "25 %"]) {
      expect(gradeRecall(recallEx, answer), answer).toBe(true);
    }
    expect(gradeRecall(recallEx, "1/3")).toBe(false);
    expect(gradeRecall(recallEx, "banana")).toBe(false);
  });
  it("compares non-numeric answers as case-insensitive collapsed text", () => {
    const textEx = { ...recallEx, acceptedAnswers: ["O(n log n)"] };
    expect(gradeRecall(textEx, "o(n  log n)")).toBe(true);
    expect(gradeRecall(textEx, "O(n^2)")).toBe(false);
  });
  it("normalizes percent and fraction forms to numbers", () => {
    expect(normalizeRecallAnswer("25%").num).toBeCloseTo(0.25, 12);
    expect(normalizeRecallAnswer("-3/6").num).toBeCloseTo(-0.5, 12);
    expect(normalizeRecallAnswer("1e-3").num).toBeCloseTo(0.001, 12);
    expect(normalizeRecallAnswer("n log n").num).toBeUndefined();
  });
});

describe.skipIf(!hasJdk())("gradePrediction - java", () => {
  const predictEx: PredictExercise = {
    id: "cr-java-901",
    kind: "predict-output",
    axis: "code-reading",
    language: "java",
    tier: 1,
    title: "int division",
    prompt: "What does this print?",
    softTimeLimitSeconds: 120,
    testTimeoutMs: 30_000,
    snippet: 'public class Main {\n    public static void main(String[] args) {\n        System.out.println(7 / 2);\n        System.out.println(7 % 2);\n    }\n}\n',
  };
  it("runs the snippet for ground truth and grades exactly", async () => {
    const r = await gradePrediction(predictEx, scratch(), "3\n1");
    expect(r.error).toBeUndefined();
    expect(r.correct).toBe(true);
  }, 60_000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run engine/grader.test.ts -t "recall"` → FAIL (`gradeRecall` not exported).
Run: `npx vitest run engine/grader.test.ts -t "gradePrediction - java"` → FAIL (java routed to the node interpreter).

- [ ] **Step 3: Implement**

`engine/grader.ts`:

1. `gradePrediction` — replace the two-language file/cmd selection:

```ts
  const file = ex.language === "python" ? "snippet.py" : ex.language === "java" ? "Main.java" : "snippet.js";
  writeFileSync(join(dir, file), ex.snippet, "utf8");
  const cmd = ex.language === "python" ? pythonCommand() : ex.language === "java" ? javaCommand() : process.execPath;
  const cmdArgs = ex.language === "java" ? [...JAVA_RUNTIME_FLAGS, file] : [file];
  let result;
  try {
    result = await run(cmd, cmdArgs, { cwd: dir, timeoutMs: ex.testTimeoutMs });
```

(The java source launcher compiles in memory — no `.class` files, no separate `javac` step. Java 21's launcher handles a single file; multi-file snippets are not supported by design.)

2. Recall grading:

```ts
/** Numeric-tolerant recall normalization: "1/4", "0.25", "25%" all mean 0.25. */
export function normalizeRecallAnswer(s: string): { num?: number; text: string } {
  const text = s.trim().toLowerCase().replace(/\s+/g, " ");
  const compact = text.replace(/\s+/g, "");
  const pct = /^(-?(?:\d+\.?\d*|\.\d+))%$/.exec(compact);
  if (pct) return { num: Number.parseFloat(pct[1]!) / 100, text };
  const frac = /^(-?(?:\d+\.?\d*|\.\d+))\/((?:\d+\.?\d*|\.\d+))$/.exec(compact);
  if (frac) {
    const denominator = Number.parseFloat(frac[2]!);
    if (denominator !== 0) return { num: Number.parseFloat(frac[1]!) / denominator, text };
  }
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?$/.test(compact)) {
    return { num: Number.parseFloat(compact), text };
  }
  return { text };
}

export function gradeRecall(ex: RecallExercise, answer: string): boolean {
  const given = normalizeRecallAnswer(answer);
  return ex.acceptedAnswers.some((accepted) => {
    const want = normalizeRecallAnswer(accepted);
    if (given.num !== undefined && want.num !== undefined) {
      return Math.abs(given.num - want.num) <= 1e-9 * Math.max(1, Math.abs(want.num));
    }
    return given.text === want.text;
  });
}
```

Import `RecallExercise` from `../bank/schema.js`.

`engine/session.ts`:

1. `runDrill` switch: `case "recall": return recallDrill(ex, solutionOverride);`

2. Add `recallDrill` (mirrors `clozeDrill`, plus the reveal):

```ts
// ---------- recall (short answer, numeric-tolerant) ----------

async function recallDrill(ex: RecallExercise, solutionOverride?: string): Promise<DrillOutcome> {
  const started = Date.now();
  const elapsed = () => (Date.now() - started) / 1000;

  const finish = (correct: boolean): DrillOutcome => {
    if (correct) console.log(pc.green("\n✓ correct") + pc.dim(` in ${Math.round(elapsed())}s`));
    else console.log(pc.red("\n✗ nope.") + ` Accepted: ${ex.acceptedAnswers.join(" | ")}`);
    if (ex.reveal) console.log(pc.dim(`\n${ex.reveal.trim()}`));
    return makeOutcome(ex, correct ? 1 : 0, elapsed());
  };

  if (solutionOverride) {
    const answer = readFileSync(solutionOverride, "utf8").split(/\r?\n/)[0] ?? "";
    return finish(gradeRecall(ex, answer));
  }

  printHeader(ex);
  printTimer(ex);

  return withReadline(async (rl) => {
    const answer = (await rl.question(pc.bold("\nYour answer (q to abandon) > "))).trim();
    if (answer.toLowerCase() === "q") return makeOutcome(ex, 0, elapsed(), true);
    return finish(gradeRecall(ex, answer));
  });
}
```

Import `gradeRecall` from `./grader.js` and `RecallExercise` from `../bank/schema.js`.

3. `previewExercise` — add:

```ts
    case "recall":
      console.log(pc.dim("(you would type a short answer; numeric forms like 1/4, 0.25, 25% are equivalent)"));
      break;
```

4. Create `engine/session.test.ts` covering the non-interactive recall path end to end:

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RecallExercise } from "../bank/schema.js";
import { runDrill } from "./session.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const recallEx: RecallExercise = {
  id: "rec-any-902",
  kind: "recall",
  axis: "decomposition",
  language: "any",
  tier: 1,
  title: "t",
  prompt: "p",
  softTimeLimitSeconds: 120,
  testTimeoutMs: 10_000,
  acceptedAnswers: ["42"],
};

function answerFile(content: string): string {
  const d = mkdtempSync(join(tmpdir(), "atrophy-session-"));
  dirs.push(d);
  const f = join(d, "answer.txt");
  writeFileSync(f, content, "utf8");
  return f;
}

describe("runDrill recall via --solution", () => {
  it("scores 1 for an equivalent numeric answer", async () => {
    const outcome = await runDrill(recallEx, answerFile("42.0\n"));
    expect(outcome.passed).toBe(1);
    expect(outcome.total).toBe(1);
    expect(outcome.score).toBe(1);
  });
  it("scores 0 for a wrong answer", async () => {
    const outcome = await runDrill(recallEx, answerFile("41\n"));
    expect(outcome.passed).toBe(0);
  });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run engine/ && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add engine/grader.ts engine/session.ts engine/grader.test.ts engine/session.test.ts
git commit -m "feat(engine): java predict-output via source launcher; recall kind grading + drill flow"
```

---

### Task 14: Doctor — `checkJava` + `checkPacks`

**Files:**
- Modify: `cli/doctor.ts` (new checks; `DoctorDeps` gains `packDirs: string[]`; wire into `runDoctor`)
- Modify: `cli/index.ts` (doctor command passes `packDirs()`)
- Test: `cli/doctor.test.ts`

**Interfaces:**
- Consumes: `javacCommand`, `parseJavaMajor`, `MIN_JDK_MAJOR`, `missingJdkHint` (Task 9); `loadBank` (Task 5); `packDirs` (Task 6).
- Produces: `checkJava(): CheckResult` (pass ≥ 21; warn below 21 or missing — Java drills degrade, py/js unaffected); `checkPacks(dirs: string[]): CheckResult` (pass with per-dir exercise counts; fail on unloadable pack; pass "no packs configured" when empty).

- [ ] **Step 1: Write the failing tests**

Append to `cli/doctor.test.ts` (follow the file's existing style; add imports for `checkJava`, `checkPacks`, plus `mkdtempSync/rmSync/writeFileSync`, `tmpdir`, `join`):

```ts
describe("checkJava", () => {
  it("returns a CheckResult and never throws", () => {
    const r = checkJava();
    expect(r.name).toBe("Java (JDK)");
    expect(["pass", "warn"]).toContain(r.status);
    if (r.status === "warn") expect(r.detail).toMatch(/JDK|ATROPHY_JAVA_HOME/);
  });
});

describe("checkPacks", () => {
  it("passes quietly with no packs", () => {
    expect(checkPacks([])).toEqual({ name: "Packs", status: "pass", detail: "no packs configured" });
  });
  it("counts exercises per pack and fails on a broken one", () => {
    const good = mkdtempSync(join(tmpdir(), "atrophy-pack-"));
    writeFileSync(
      join(good, "ok.json"),
      JSON.stringify({ id: "rec-any-101", kind: "recall", axis: "decomposition", language: "any", tier: 1, title: "t", prompt: "p", softTimeLimitSeconds: 60, acceptedAnswers: ["x"] }),
      "utf8",
    );
    const broken = mkdtempSync(join(tmpdir(), "atrophy-pack-"));
    writeFileSync(join(broken, "bad.json"), "{nope", "utf8");
    try {
      expect(checkPacks([good]).status).toBe("pass");
      expect(checkPacks([good]).detail).toMatch(/1 exercise/);
      expect(checkPacks([good, broken]).status).toBe("fail");
    } finally {
      rmSync(good, { recursive: true, force: true });
      rmSync(broken, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run cli/doctor.test.ts -t "checkJava|checkPacks"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

In `cli/doctor.ts`:

```ts
import { MIN_JDK_MAJOR, javacCommand, missingJdkHint, parseJavaMajor } from "../engine/javatool.js";

/** JDK present and modern enough for Java drills. Warn-only: py/js drills are unaffected. */
export function checkJava(): CheckResult {
  const cmd = javacCommand();
  try {
    const r = spawnSync(cmd, ["-version"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    if (r.status === 0) {
      const version = (r.stdout || r.stderr || "").trim();
      const major = parseJavaMajor(version);
      if (major !== null && major < MIN_JDK_MAJOR) {
        return { name: "Java (JDK)", status: "warn", detail: `${version} - Java drills need JDK >= ${MIN_JDK_MAJOR}` };
      }
      return { name: "Java (JDK)", status: "pass", detail: `${cmd}: ${version}` };
    }
  } catch {
    /* fall through to warn */
  }
  return { name: "Java (JDK)", status: "warn", detail: missingJdkHint(cmd) };
}

/** Every configured pack dir loads cleanly. Packs run code - only add dirs you trust. */
export function checkPacks(dirs: string[]): CheckResult {
  if (dirs.length === 0) return { name: "Packs", status: "pass", detail: "no packs configured" };
  const parts: string[] = [];
  for (const dir of dirs) {
    try {
      const n = loadBank(dir).length;
      parts.push(`${dir}: ${n} exercise${n === 1 ? "" : "s"}`);
    } catch (err) {
      return { name: "Packs", status: "fail", detail: `${dir}: ${(err as Error).message}` };
    }
  }
  return { name: "Packs", status: "pass", detail: parts.join(" · ") };
}
```

Extend `DoctorDeps` with `packDirs: string[]`, and in `runDoctor` insert `checkJava(),` after `checkPython(),` and `checkPacks(deps.packDirs),` after `checkBank(...)`. In `cli/index.ts`'s doctor action, pass `packDirs: packDirs()` (already imported from `./config.js` in Task 7).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run cli/doctor.test.ts && npm run typecheck`
Expected: PASS.
Smoke: `npm run dev -- doctor` → shows `✓ Java (JDK)   javac: javac 21.0.9` and `✓ Packs   no packs configured`.

- [ ] **Step 5: Commit**

```bash
git add cli/doctor.ts cli/doctor.test.ts cli/index.ts
git commit -m "feat(doctor): JDK and pack checks"
```

---

### Task 15: Bank integrity — `ATROPHY_BANK` override + Java invariants

**Files:**
- Modify: `bank/bank-integrity.test.ts`

**Interfaces:**
- Consumes: `hasJdk` (Task 9), `grade` for harness kinds (Task 12), `isHarness`/`HarnessExercise` (Task 3).
- Produces: the integrity suite validates ANY bank dir via `ATROPHY_BANK` (this is how packs get validated locally: `$env:ATROPHY_BANK="<pack-dir>"; npx vitest run bank/bank-integrity.test.ts`). Java content gets its own JDK-gated describe with 300s budgets.

- [ ] **Step 1: Write the failing/new tests**

Rework `bank/bank-integrity.test.ts`:

1. Bank root becomes overridable:

```ts
const bankRoot = process.env.ATROPHY_BANK ?? join(here, "exercises");
const bank = loadBank(bankRoot);
```

2. Existing `fix` and `predict-output` loops filter to non-java (`.filter((e) => e.language !== "java")`) so a JDK-less machine still validates py/js. Guard the fix suite's `expect(fixes.length).toBeGreaterThan(0)` to only assert when the unfiltered bank has non-java fixes (a pure-java pack must not fail it).

3. Add the Java describe:

```ts
import { hasJdk, javacCommand, JAVA_COMPILE_TIMEOUT_MS } from "../engine/javatool.js";
import { run } from "../engine/runner.js";
import { isHarness, type CodeLikeExercise } from "./schema.js";

const javaCode = bank.filter(
  (e): e is CodeLikeExercise =>
    (e.kind === "write" || e.kind === "fix" || isHarness(e)) && e.language === "java",
);

if (!hasJdk()) console.warn("⚠ JDK not found - Java exercises NOT validated. Install JDK 21.");
describe.skipIf(!hasJdk())("bank integrity - java", () => {
  it("every java starter compiles (no javac vomit on first submit)", async () => {
    for (const ex of javaCode) {
      const dir = scratch();
      writeFileSync(join(dir, "Solution.java"), ex.starterCode, "utf8");
      const r = await run(javacCommand(), ["-encoding", "UTF-8", "Solution.java"], { cwd: dir, timeoutMs: JAVA_COMPILE_TIMEOUT_MS });
      expect(r.exitCode, `${ex.id}: starter does not compile:\n${r.stderr}`).toBe(0);
    }
  }, 300_000);

  it("every java fix/fix-harness starter actually fails, and harness totals match totalChecks", async () => {
    for (const ex of javaCode.filter((e) => e.kind === "fix" || e.kind === "fix-harness")) {
      const dir = scratch();
      writeFileSync(join(dir, solutionFileName(ex)), ex.starterCode, "utf8");
      const r = await grade(ex, dir);
      expect(r.harnessError, `${ex.id}: ${r.harnessError}`).toBeUndefined();
      expect(r.passed, `${ex.id}: planted bug passes all checks - no bug to find`).toBeLessThan(r.total);
    }
    for (const ex of javaCode.filter(isHarness)) {
      const dir = scratch();
      writeFileSync(join(dir, solutionFileName(ex)), ex.starterCode, "utf8");
      const r = await grade(ex, dir);
      // grade() itself hard-fails on a total mismatch; reaching here with no harnessError proves the contract
      expect(r.harnessError, `${ex.id}: ${r.harnessError}`).toBeUndefined();
      expect(r.total, `${ex.id}: reported total must equal totalChecks`).toBe(ex.totalChecks);
    }
  }, 300_000);

  it("every java predict-output snippet runs cleanly and deterministically", async () => {
    for (const ex of bank.filter((e) => e.kind === "predict-output" && e.language === "java")) {
      const first = await gradePrediction(ex, scratch(), "");
      expect(first.error, `${ex.id}: ${first.error}`).toBeUndefined();
      expect(first.actual, `${ex.id}: snippet prints nothing`).toBeTruthy();
      const second = await gradePrediction(ex, scratch(), first.actual!);
      expect(second.correct, `${ex.id}: output is not deterministic`).toBe(true);
    }
  }, 300_000);
});
```

(No shipped Java exercises exist until Plan B — these loops are empty but alive; Plan B's content lands into an already-armed gate. The doctor/config tests from earlier tasks prove non-empty behavior with fixtures.)

- [ ] **Step 2: Run the suite**

Run: `npx vitest run bank/bank-integrity.test.ts`
Expected: PASS (java loops iterate zero exercises; py/js invariants unchanged).

- [ ] **Step 3: Verify the pack-validation path works**

Run (PowerShell): `$env:ATROPHY_BANK="$env:TEMP\definitely-missing"; npx vitest run bank/bank-integrity.test.ts; Remove-Item Env:ATROPHY_BANK`
Expected: FAIL with ENOENT — proving the override is live. Unset and re-run to green.

- [ ] **Step 4: Commit**

```bash
git add bank/bank-integrity.test.ts
git commit -m "test(bank): ATROPHY_BANK-overridable integrity suite with java invariants"
```

---

### Task 16: CI + docs

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md` (install section line 115, contributing line 156, command table `--lang` row, data section env vars)
- Modify: `CLAUDE.md` (commands env-var list, architecture invariants)

**Interfaces:** none — documentation and CI truth.

- [ ] **Step 1: CI — add the JDK**

In `.github/workflows/ci.yml` after the `setup-python` step:

```yaml
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: "21"
```

- [ ] **Step 2: README updates**

- Install section: "Requires Node.js ≥ 22, plus Python 3 on `PATH` for Python exercises and a JDK ≥ 21 (Temurin recommended) for Java exercises."
- `--lang` row: `atrophy drill --lang python` → "Only Python (or `javascript`, `java`) exercises".
- Add a **Packs** subsection under "Your data":

```markdown
### Packs

Extra exercise directories can merge with the built-in bank: set `ATROPHY_PACKS`
(path-list, `;`-separated on Windows) or add `"packs": ["C:/path/to/pack"]` to
`~/.atrophy/config.json`. Duplicate exercise ids fail loudly. Packs are code that
runs on your machine during grading - only add directories you trust. Validate a
pack with `ATROPHY_BANK=<dir> npx vitest run bank/bank-integrity.test.ts`.
```

- Contributing: mention Java exercises follow the same one-JSON-file flow, and behavioral drills use `write-harness`/`fix-harness` with `testCode` + `totalChecks`.

- [ ] **Step 3: CLAUDE.md updates**

- Env-var list gains: `ATROPHY_PACKS` (additive pack dirs), `ATROPHY_JAVA_HOME` (JDK override; needed for scoop/mise shim installs).
- Architecture bullet for `bank/`: kinds now include `write-harness`/`fix-harness` (Java-only, `testCode` + `totalChecks`, grade-time total enforcement) and `recall` (numeric-tolerant answers); `loadBank` merges multiple dirs.
- Architecture bullet for `engine/`: Java grading = `javac` + `java` two-step, JDK 21 floor, pinned `-Duser.*`/UTF-8 flags, resources at `engine/java/` with the same dev/built dual-path rule (and listed in `package.json` `files`).
- Invariants: add "`--ai-on` rule unchanged; harness-reported totals must equal `totalChecks` or the rating must not move".

- [ ] **Step 4: Full verification**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green (Java suites run because the JDK is present locally).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml README.md CLAUDE.md
git commit -m "docs+ci: java 21 in CI, packs and java documentation"
```

---

### Task 17: End-to-end smoke + fixture drill

**Files:** none created permanently (scratch fixtures only)

- [ ] **Step 1: Build and run the built CLI against a fixture pack**

PowerShell:

```powershell
npm run build
$pack = Join-Path $env:TEMP "atrophy-smoke-pack"
New-Item -ItemType Directory -Force $pack | Out-Null
@'
{
  "id": "sr-java-990",
  "kind": "write",
  "axis": "syntax-recall",
  "language": "java",
  "tier": 1,
  "title": "FizzBuzz cell",
  "prompt": "Return \"Fizz\" for multiples of 3, \"Buzz\" for 5, \"FizzBuzz\" for both, else the number as a string.",
  "functionName": "cell",
  "starterCode": "public class Solution {\n    static String cell(int n) {\n        throw new UnsupportedOperationException(\"implement me\");\n    }\n}\n",
  "softTimeLimitSeconds": 300,
  "testTimeoutMs": 30000,
  "tests": [
    { "args": [3], "expected": "Fizz" },
    { "args": [10], "expected": "Buzz" },
    { "args": [15], "expected": "FizzBuzz" },
    { "args": [7], "expected": "7" }
  ]
}
'@ | Set-Content (Join-Path $pack "sr-java-990.json") -Encoding utf8

$solution = Join-Path $env:TEMP "smoke-solution.java"
@'
public class Solution {
    static String cell(int n) {
        if (n % 15 == 0) return "FizzBuzz";
        if (n % 3 == 0) return "Fizz";
        if (n % 5 == 0) return "Buzz";
        return String.valueOf(n);
    }
}
'@ | Set-Content $solution -Encoding utf8

$env:ATROPHY_DB = Join-Path $env:TEMP "atrophy-smoke.db"
$env:ATROPHY_NO_SYNC = "1"
$env:ATROPHY_PACKS = $pack
node dist/cli/index.js drill --exercise sr-java-990 --solution $solution
node dist/cli/index.js stats
node dist/cli/index.js doctor
```

Expected: drill prints `Score 1.00 · syntax-recall rating 1200 → …`; stats shows one rep; doctor shows the pack with 1 exercise and a passing JDK check.

- [ ] **Step 2: Verify the packed layout**

```powershell
npm pack --dry-run
```

Expected: the file list includes `engine/java/Harness.java` and `engine/java/Atrophy.java`.

- [ ] **Step 3: Clean up and push the branch**

```powershell
Remove-Item Env:ATROPHY_DB, Env:ATROPHY_NO_SYNC, Env:ATROPHY_PACKS
git push -u origin feat/java-language-support
```

---

## Self-Review (completed)

- **Spec coverage:** schema §2 → Tasks 1–5; grading §3.1–3.3 → Tasks 9–12; recall §3.4 + predict §3.5 → Task 13; packs §4 → Tasks 5–7, 14, 15; CLI/doctor/CI §6 → Tasks 7, 14, 16; testing §7 → every task + 15, 17. **Deliberately deferred to Plan B:** generators (§5), built-in bank + pack content (§8). Deferred to Plan C: waves 2–3, wave X (incl. the SQL mini-spec). Accepted limitations (§9) need no code.
- **Placeholder scan:** none — every step carries runnable code/commands.
- **Type consistency:** `CodeLikeExercise`/`HarnessExercise`/`RecallExercise` (Task 3/2) match uses in Tasks 11–13/15; `packDirs` (Task 6) matches Tasks 7/14; `parseMarker`/`compileAndRunJava` (Task 11) match Task 12; `Atrophy.plan/check/report/watchdog` (Task 10) match Task 12's `testCode` fixtures.
