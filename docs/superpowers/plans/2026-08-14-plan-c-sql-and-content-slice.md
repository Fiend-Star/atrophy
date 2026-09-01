# Plan C: SQL Modality + Curated Content Slice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship SQL as a graded language (behavioral execution on better-sqlite3), close every engine carry from Plan B, and land a frozen ~92-drill content slice (SQL unblocks + wave-2 value + wave-3 breadth).

**Architecture:** SQL rides the existing `write` kind and JS grading lane (Approach 1): schema gains `cases`/`ordered` fields gated by refinement, the grader emits a Node script that builds `:memory:` DBs per case and prints the standard `ATROPHY_RESULT` marker. Multi-blank cloze, generator language widening, toolchain-aware selection, and the per-kind vacuity guard are small engine tasks that unblock content. Content tasks then parallelize by domain, exactly like Plan B.

**Tech Stack:** TypeScript (strict, NodeNext ESM), zod, vitest, better-sqlite3 (already a prod dependency), Node ≥ 22.

**Spec:** `docs/superpowers/specs/2026-08-14-plan-c-sql-and-content-slice-design.md` — read it first; where this plan and the spec disagree, the spec wins. Plan B's execution rulings also bind all harness content (see Global Constraints).

## Global Constraints

- ESM throughout: **relative imports use `.js` extensions inside `.ts` files**; strict TS with `noUncheckedIndexedAccess`; tests colocated `*.test.ts`; no vitest config changes (the existing `vitest.config.ts` exclusion of `.claude/**` stays).
- Windows-safe everything (CI runs ubuntu + windows); never spawn through a shell.
- `ATROPHY_NO_SYNC=1` + throwaway `ATROPHY_DB` for ANY command that records a session. Never touch the real `~/.atrophy` DB.
- `npm run dev -- drill …` swallows flags on Windows — use `npx tsx cli/index.ts …` (source) or `node dist/cli/index.js …` (built).
- Harness content conventions (Plan B rulings, binding): N−1 totals (`Atrophy.plan(N)`/`totalChecks` count behavioral+scan checks only); the verbatim `catch (Throwable t) { Atrophy.check("harness crashed: " + t, false); } finally { Atrophy.report(); }`; no default-satisfiable check; untouched write-harness starters grade 0/N **by running**; deadline-race rule (worker holds strictly longer than every main-side proof deadline); verdict-before-release; subset counters increment-after-acquire / decrement-before-release; sampling loops ITER ≥ 2000; scans run before behavioral checks; scan count ≤ behavioral count per drill.
- **Reference-grading is mandatory in every content task:** the implementer grades their reference solution to 1.00 through the real CLI before committing, and records the command + score in their report. This is the only net for unpassable drills.
- Pack commits (Java-OAs repo) stage ONLY the named files under `atrophy-pack/exercises/` — never `git add -A`.
- Java drills: `starterCode` compiles (`javac` exit 0), `public class Solution`, no `package` line, graded method package-private or public and unique by arity; integer test values within ±2^53.
- SQL drills: SQLite dialect only (no MySQL-isms); `expectedRows` values are JSON scalars; every sql write ships ≥ 2 cases with ≥ 2 distinct canonical `expectedRows`.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File Structure

- `bank/schema.ts` — LANGUAGES + `JVM_KINDS` export + sql write shape + multi-blank cloze shape (Tasks 1–2)
- `engine/cloze.ts` (new) — pure cloze grading unit (Task 2)
- `engine/grader.ts` — sql emit branch (Task 3)
- `engine/session.ts` — `.sql` solution files, per-blank cloze prompting (Tasks 2–3)
- `engine/select.ts` — toolchain-aware filtering, `"any"`-language generators (Task 4)
- `bank/generators/types.ts` — language widening (Task 4)
- `bank/bank-integrity.test.ts` — per-kind vacuity split (Task 4), sql gates (Task 5)
- `cli/doctor.ts` — sql always-available line (Task 3)
- `bank/exercises/syntax-recall/sr-sql-00{1,2,3}.json` — built-in sql statics (Task 6)
- `Java-OAs/atrophy-pack/exercises/**` — all pack content (Tasks 7–15)
- `README.md`, `CLAUDE.md` — wrap docs (Task 16)

---

### Task 1: Schema — sql language, JVM_KINDS export, sql write shape

**Files:**
- Modify: `bank/schema.ts`
- Test: `bank/schema.test.ts`

**Interfaces:**
- Produces: `LANGUAGES` including `"sql"`; `export const JVM_KINDS = ["write", "fix", "write-harness", "fix-harness"] as const` + `export type JvmKind`; `SqlWriteExercise` type; `isSqlWrite(ex: Exercise): ex is SqlWriteExercise`; `sqlCaseSchema` (`{ fixture: string; expectedRows: Record<string, unknown>[] }`); `totalUnits` returning `ex.cases.length` for sql writes. Consumed by Tasks 3, 4, 5.

- [ ] **Step 1: Write the failing tests** (append to `bank/schema.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { exerciseSchema, isSqlWrite, JVM_KINDS, totalUnits } from "./schema.js";

const base = {
  id: "sr-sql-901", axis: "syntax-recall", tier: 1, prompt: "p",
  softTimeLimitSeconds: 60,
};
const sqlCases = [
  { fixture: "CREATE TABLE t(a INT); INSERT INTO t VALUES (1);", expectedRows: [{ a: 1 }] },
  { fixture: "CREATE TABLE t(a INT); INSERT INTO t VALUES (2);", expectedRows: [{ a: 2 }] },
];

describe("sql write shape", () => {
  it("accepts a well-formed sql write (cases, no tests/functionName)", () => {
    const ex = exerciseSchema.parse({ ...base, kind: "write", language: "sql", starterCode: "-- q", cases: sqlCases });
    expect(isSqlWrite(ex)).toBe(true);
    expect(totalUnits(ex)).toBe(2);
  });
  it("rejects sql write with tests or functionName", () => {
    expect(() => exerciseSchema.parse({ ...base, kind: "write", language: "sql", starterCode: "-- q", cases: sqlCases, functionName: "f" })).toThrow();
    expect(() => exerciseSchema.parse({ ...base, kind: "write", language: "sql", starterCode: "-- q", cases: sqlCases, tests: [{ args: [], expected: 1 }] })).toThrow();
  });
  it("rejects sql write with < 2 cases or all-identical expectedRows", () => {
    expect(() => exerciseSchema.parse({ ...base, kind: "write", language: "sql", starterCode: "-- q", cases: [sqlCases[0]] })).toThrow();
    expect(() => exerciseSchema.parse({ ...base, kind: "write", language: "sql", starterCode: "-- q", cases: [sqlCases[0], sqlCases[0]] })).toThrow();
  });
  it("rejects non-sql write with cases/ordered, and keeps today's contract intact", () => {
    expect(() => exerciseSchema.parse({ ...base, kind: "write", language: "python", functionName: "f", starterCode: "def f(): pass", tests: [{ args: [], expected: 1 }], cases: sqlCases })).toThrow();
    expect(() => exerciseSchema.parse({ ...base, kind: "write", language: "python", starterCode: "def f(): pass", tests: [{ args: [], expected: 1 }] })).toThrow(); // functionName still required off-sql
  });
  it("rejects sql on fix and predict-output", () => {
    expect(() => exerciseSchema.parse({ ...base, kind: "fix", language: "sql", starterCode: "-- q", cases: sqlCases })).toThrow();
    expect(() => exerciseSchema.parse({ ...base, kind: "predict-output", language: "sql", snippet: "SELECT 1;" })).toThrow();
  });
  it("exports JVM_KINDS as the four java-graded kinds", () => {
    expect([...JVM_KINDS]).toEqual(["write", "fix", "write-harness", "fix-harness"]);
  });
});
```

- [ ] **Step 2: Run to verify failure.** `npx vitest run bank/schema.test.ts` — expect failures on missing `JVM_KINDS`/`isSqlWrite` exports and sql parse rejections.
- [ ] **Step 3: Implement in `bank/schema.ts`.** `LANGUAGES` becomes `["python", "javascript", "java", "sql"] as const`. Add `export const JVM_KINDS = ["write", "fix", "write-harness", "fix-harness"] as const; export type JvmKind = (typeof JVM_KINDS)[number];`. Widen the write/fix arm's raw shape: `functionName` and `tests` become `.optional()`, add `cases: z.array(z.object({ fixture: z.string().min(1), expectedRows: z.array(z.record(z.string(), z.unknown())) })).min(2).optional()` and `ordered: z.boolean().optional()`. Attach a `superRefine` to the whole union (or a wrapping refinement — keep `discriminatedUnion` as the core):
  - `kind === "write" && language === "sql"` ⇒ `cases` present; `tests`, `functionName` absent; at least two `cases` whose `canonicalRows(expectedRows)` differ (canonical = `JSON.stringify` with sorted object keys per row, rows sorted by that string — write a tiny local `canonicalRows` helper and export it for Tasks 3/5).
  - `kind === "write" && language !== "sql"` ⇒ `tests` + `functionName` present; `cases`, `ordered` absent.
  - `kind === "fix"` ⇒ `language !== "sql"` and `tests` + `functionName` present, `cases`/`ordered` absent.
  - `kind === "predict-output"` ⇒ `language !== "sql"`.
  Add `SqlWriteExercise` type, `isSqlWrite`, and the `totalUnits` write branch: `isSqlWrite(ex) ? ex.cases.length : ex.tests.length` (types make `tests` optional now — narrow through `isSqlWrite` so no non-null assertions).
- [ ] **Step 4: Verify.** `npx vitest run bank/schema.test.ts` passes; `npm run typecheck` clean — fix every consumer the optionality breaks by narrowing through `isSqlWrite`/`isCode`, never with `!`. Replace the grader's/integrity suite's local JVM-kind lists with imports of `JVM_KINDS`.
- [ ] **Step 5: Full suite + commit.** `npm test` green. `git commit -m "feat(schema): sql language, sql write cases, JVM_KINDS export"`.

### Task 2: Multi-blank cloze

**Files:**
- Modify: `bank/schema.ts` (cloze arm), `engine/session.ts` (cloze branch)
- Create: `engine/cloze.ts`
- Test: `engine/cloze.test.ts`, additions to `bank/schema.test.ts`

**Interfaces:**
- Consumes: `ClozeExercise` from Task 1's schema state.
- Produces: `countBlanks(snippet: string): number`; `gradeCloze(ex: ClozeExercise, answers: string[]): { blanksCorrect: number; totalBlanks: number }`; `acceptedForBlank(ex: ClozeExercise, i: number): string[]`. `totalUnits(cloze)` returns the blank count. Session prompts once per blank in order. Consumed by Tasks 5 (integrity re-assert) and content tasks.

- [ ] **Step 1: Failing tests** (`engine/cloze.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { countBlanks, gradeCloze, acceptedForBlank } from "./cloze.js";
import { exerciseSchema } from "../bank/schema.js";

const mk = (snippet: string, acceptedAnswers: string[] | string[][]) =>
  exerciseSchema.parse({ id: "api-x-901", axis: "api-memory", tier: 1, prompt: "p", softTimeLimitSeconds: 60, kind: "cloze", language: "java", snippet, acceptedAnswers });

describe("multi-blank cloze", () => {
  it("single-blank back-compat: flat string[] still parses and grades", () => {
    const ex = mk("map.____(k, 0)", ["putIfAbsent"]);
    expect(countBlanks(ex.snippet)).toBe(1);
    expect(gradeCloze(ex, ["putIfAbsent"])).toEqual({ blanksCorrect: 1, totalBlanks: 1 });
    expect(gradeCloze(ex, ["put"])).toEqual({ blanksCorrect: 0, totalBlanks: 1 });
  });
  it("two blanks with per-blank accepted sets, partial credit", () => {
    const ex = mk("a.____(x); b.____(y)", [["add", "addLast"], ["remove"]]);
    expect(gradeCloze(ex, ["addLast", "nope"])).toEqual({ blanksCorrect: 1, totalBlanks: 2 });
    expect(acceptedForBlank(ex, 1)).toEqual(["remove"]);
  });
  it("answers are trimmed before comparison", () => {
    const ex = mk("x.____()", ["stream"]);
    expect(gradeCloze(ex, ["  stream "]).blanksCorrect).toBe(1);
  });
  it("schema rejects per-blank shape whose length mismatches the blank count", () => {
    expect(() => mk("only one ____", [["a"], ["b"]])).toThrow();
    expect(() => mk("____ and ____", [["a"]])).toThrow();
  });
});
```

Also add to `bank/schema.test.ts`: `totalUnits` of a two-blank cloze is 2; of a flat single-blank cloze is 1.

- [ ] **Step 2: Verify failure**, then implement. Schema: `acceptedAnswers: z.union([z.array(z.string().min(1)).min(1), z.array(z.array(z.string().min(1)).min(1)).min(1)])` + superRefine: if nested, `length === countBlanks(snippet)`; if flat, `countBlanks(snippet) === 1`. `countBlanks` = number of `____` occurrences (`snippet.match(/____/g)`) — define it in `engine/cloze.ts` and import into schema (schema already imports nothing from engine — if that import direction is awkward, define `countBlanks` in `bank/schema.ts` and re-export from `engine/cloze.ts`; keep ONE definition). `gradeCloze`: normalize `answers[i].trim()`, compare against `acceptedForBlank(ex, i)` (flat shape → blank 0's set is the flat array). `totalUnits` cloze branch returns `countBlanks(ex.snippet)`.
- [ ] **Step 3: Session.** In the cloze branch of `engine/session.ts`, prompt once per blank in order (`Blank 1/2:` prefixes when > 1), collect `answers[]`, score `blanksCorrect / totalBlanks` through the existing scoring path (the fraction feeds the same place the old 0-or-1 did). `--solution <file>` mode: file supplies one answer per line.
- [ ] **Step 4: Verify.** `npx vitest run engine/cloze.test.ts bank/schema.test.ts`; `npm run typecheck`; `npm test` (the shipped single-blank clozes in the bank must all still validate — the integrity suite run inside `npm test` is the proof).
- [ ] **Step 5: Commit.** `git commit -m "feat(cloze): multi-blank support with per-blank accepted sets"`.

### Task 3: Grader sql branch + session/doctor plumbing

**Files:**
- Modify: `engine/grader.ts`, `engine/session.ts` (solution filename), `cli/doctor.ts`
- Test: `engine/grader.sql.test.ts`

**Interfaces:**
- Consumes: `SqlWriteExercise`, `isSqlWrite`, `canonicalRows` (Task 1).
- Produces: sql grading end-to-end — `grade(ex, solutionPath)` (the existing entry) handles sql writes; solution files named `solution.sql`; doctor prints sql availability. Consumed by Tasks 5, 6, and all SQL content.

- [ ] **Step 1: Failing tests** (`engine/grader.sql.test.ts`) — these run the REAL subprocess (no skipIf; better-sqlite3 is always present):

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grade } from "./grader.js";           // adapt to the real entry-point name used by write/fix grading
import { exerciseSchema } from "../bank/schema.js";

const ex = exerciseSchema.parse({
  id: "sr-sql-902", axis: "syntax-recall", tier: 1, prompt: "sum per key", softTimeLimitSeconds: 60,
  kind: "write", language: "sql", starterCode: "-- SELECT ...",
  cases: [
    { fixture: "CREATE TABLE t(k TEXT, v INT); INSERT INTO t VALUES ('a',1),('a',2),('b',5);", expectedRows: [{ k: "a", s: 3 }, { k: "b", s: 5 }] },
    { fixture: "CREATE TABLE t(k TEXT, v INT); INSERT INTO t VALUES ('z',7);", expectedRows: [{ k: "z", s: 7 }] },
  ],
});
const solve = (sql: string) => { const d = mkdtempSync(join(tmpdir(), "atrophy-sql-")); const p = join(d, "solution.sql"); writeFileSync(p, sql, "utf8"); return p; };

describe("sql grading", () => {
  it("correct query passes both cases", async () => {
    const r = await grade(ex, solve("SELECT k, SUM(v) AS s FROM t GROUP BY k"));
    expect(r.passed).toBe(2); expect(r.total).toBe(2);
  });
  it("row order is immaterial when ordered is absent", async () => {
    const r = await grade(ex, solve("SELECT k, SUM(v) AS s FROM t GROUP BY k ORDER BY k DESC"));
    expect(r.passed).toBe(2);
  });
  it("hardcoded UNION literal fails the second case", async () => {
    const r = await grade(ex, solve("SELECT 'a' AS k, 3 AS s UNION ALL SELECT 'b', 5"));
    expect(r.passed).toBe(1);
  });
  it("wrong alias fails (column names are part of the answer)", async () => {
    const r = await grade(ex, solve("SELECT k, SUM(v) AS total FROM t GROUP BY k"));
    expect(r.passed).toBe(0);
  });
  it("syntax error and multi-statement fail as named case errors, not crashes", async () => {
    expect((await grade(ex, solve("SELEC nope"))).passed).toBe(0);
    expect((await grade(ex, solve("SELECT 1; SELECT 2;"))).passed).toBe(0);
  });
  it("bundled sqlite has window functions and sqrt (content depends on both)", async () => {
    const probe = exerciseSchema.parse({ ...ex, id: "sr-sql-903", cases: [
      { fixture: "CREATE TABLE n(x REAL); INSERT INTO n VALUES (4.0),(9.0);", expectedRows: [{ r: 2.0 }, { r: 3.0 }] },
      { fixture: "CREATE TABLE n(x REAL); INSERT INTO n VALUES (16.0);", expectedRows: [{ r: 4.0 }] },
    ]});
    const r = await grade(probe, solve("SELECT sqrt(x) AS r, ROW_NUMBER() OVER (ORDER BY x) AS rn FROM n")); // rn unused in expected → this variant must FAIL
    expect(r.passed).toBe(0);
    const r2 = await grade(probe, solve("SELECT sqrt(x) AS r FROM n"));
    expect(r2.passed).toBe(2);
  });
});
```

- [ ] **Step 2: Verify failure, then implement the emit branch in `engine/grader.ts`.** Where the js lane dispatches on language, add: `isSqlWrite(ex)` → emit a script via a new local `sqlHarnessScript(ex, solutionFileName)`:

```ts
function sqlHarnessScript(ex: SqlWriteExercise): string {
  const require_ = createRequire(import.meta.url);
  const betterSqlitePath = require_.resolve("better-sqlite3");
  return `
const Database = require(${JSON.stringify(betterSqlitePath)});
const { readFileSync } = require("node:fs");
const sql = readFileSync(${JSON.stringify("solution.sql")}, "utf8");
const cases = ${JSON.stringify(ex.cases)};
const ordered = ${JSON.stringify(ex.ordered === true)};
const canonRow = (r) => JSON.stringify(Object.keys(r).sort().reduce((o, k) => (o[k] = r[k], o), {}));
const canon = (rows) => { const c = rows.map(canonRow); if (!ordered) c.sort(); return JSON.stringify(c); };
let passed = 0; const failures = [];
for (let i = 0; i < cases.length; i++) {
  try {
    const db = new Database(":memory:");
    db.exec(cases[i].fixture);
    db.pragma("query_only = 1");
    const rows = db.prepare(sql).all();
    if (canon(rows) === canon(cases[i].expectedRows)) passed++;
    else failures.push("case " + (i + 1) + ": rows differ");
  } catch (e) { failures.push("case " + (i + 1) + ": " + (e && e.message || e)); }
}
console.log("ATROPHY_RESULT " + JSON.stringify({ passed, total: cases.length, failures }));
`;
}
```

  Match the marker payload shape to what the js lane already emits for json-tests (adapt field names to the real contract — read the js emitter first). The script and `solution.sql` are written into the same temp dir the runner already uses; spawn `node <script>` through the existing `run()` sandbox with `ex.testTimeoutMs`. Number semantics: SQLite integers arrive as JS numbers within ±2^53 (better-sqlite3 default, no bigint mode) — matching `JSON.stringify` semantics already.
- [ ] **Step 3: Session + doctor.** `solutionFileName` gains `language === "sql" → "solution.sql"`. `cli/doctor.ts` adds a sql line: always available, naming the better-sqlite3 version (`require("better-sqlite3/package.json").version` via `createRequire`).
- [ ] **Step 4: Verify.** `npx vitest run engine/grader.sql.test.ts` green; `npm run typecheck`; `npm test`.
- [ ] **Step 5: Commit.** `git commit -m "feat(grader): behavioral sql grading via better-sqlite3"`.

### Task 4: Selection + generators + vacuity guard split

**Files:**
- Modify: `engine/select.ts`, `bank/generators/types.ts`, `bank/bank-integrity.test.ts`
- Test: `engine/select.test.ts` additions, `bank/generators/generators.test.ts` additions

**Interfaces:**
- Consumes: `JVM_KINDS`, `hasJdk()` (`engine/javatool.ts`).
- Produces: `ExerciseGenerator.language: Language | "any"`; selection/`availableAxes` treating `"any"` as matching every language and excluding all `language === "java"` exercises + java families when `hasJdk()` is false; integrity presence check split into `javaCode > 0` and `javaPredicts > 0` arms (sql arm arrives in Task 6).

- [ ] **Step 1: Failing tests.** In `engine/select.test.ts`: (a) a bank whose only java content is JVM-graded is not offered for `--lang java` when a `hasJdk`-style flag is false — thread testability the way the file already fakes things (if `hasJdk` is called directly, refactor selection entry points to accept an optional `toolchains?: { jdk: boolean }` parameter defaulting to the real probe — pure-function style, no module mocking); (b) a generator with `language: "any"` is counted by `availableAxes` for both `"python"` and `"java"` requests. In `generators.test.ts`: the four existing families still declare concrete languages and existing determinism snapshots are byte-identical (no re-render drift — assert one known render per family against its Plan-B-era output captured in the existing tests).
- [ ] **Step 2: Implement.** `types.ts`: `language: Language | "any"`. `select.ts`: language matching becomes `g.language === "any" || g.language === lang`; add the toolchain filter (`ex.language === "java"` excluded when `!toolchains.jdk`; same for `g.language === "java"` families). `availableAxes(bank, language?, generators)` applies the same two rules. Integrity: replace the single `javaJvm.length > 0` arm with `javaCode.length > 0` and `javaPredicts.length > 0` (both under `validatingBuiltInBank`), keeping the surrounding comment accurate.
- [ ] **Step 3: Verify + commit.** `npm test` + `npm run typecheck` green. `git commit -m "feat(select): toolchain-aware filtering, any-language generators, per-kind vacuity guard"`.

### Task 5: SQL integrity gates

**Files:**
- Modify: `bank/bank-integrity.test.ts`
- Test: itself (plus inline malformed fixtures via a scratch bank dir, following the file's existing scratch-dir pattern)

**Interfaces:**
- Consumes: `isSqlWrite`, `canonicalRows` (Task 1); sql grading (Task 3).
- Produces: gates every sql write in ANY loaded bank must pass. Consumed by Tasks 6–8 content.

- [ ] **Step 1: Write the gates** (they will pass vacuously until Task 6 ships content — that is fine; the guard arm proving non-vacuity lands with Task 6):

```ts
describe("bank integrity - sql", () => {
  const sqlWrites = bank.filter(isSqlWrite);
  it("every fixture applies cleanly and deterministically", () => {
    for (const ex of sqlWrites) for (const [i, c] of ex.cases.entries()) {
      const db = new Database(":memory:");
      expect(() => db.exec(c.fixture), `${ex.id} case ${i + 1}`).not.toThrow();
      const a = db.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
      const db2 = new Database(":memory:"); db2.exec(c.fixture);
      const b = db2.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
      expect(a).toEqual(b);
    }
  });
  it("at least two cases differ in canonical expectedRows", () => {
    for (const ex of sqlWrites) {
      const canon = new Set(ex.cases.map((c) => canonicalRows(c.expectedRows)));
      expect(canon.size, ex.id).toBeGreaterThan(1);
    }
  });
  it("the hardcoded UNION-literal cheese fails at least one case", async () => {
    for (const ex of sqlWrites) {
      const src = ex.cases.find((c) => c.expectedRows.length > 0)!;
      const cols = Object.keys(src.expectedRows[0]!);
      const lit = (r: Record<string, unknown>) => "SELECT " + cols.map((k) => `${JSON.stringify(r[k]).replace(/"/g, "'")} AS ${k}`).join(", ");
      const cheese = src.expectedRows.map(lit).join(" UNION ALL ");
      const r = await gradeSqlSource(ex, cheese);   // helper: write cheese to a scratch solution.sql, call grade()
      expect(r.passed, ex.id).toBeLessThan(ex.cases.length);
    }
  });
});
```

  Import `Database` from better-sqlite3 directly here (the suite may use in-process sqlite; only real grading goes through the subprocess). Write the small `gradeSqlSource(ex, sql)` helper against the Task 3 grade entry.
- [ ] **Step 2: Prove the gates bite.** Point `ATROPHY_BANK` at a scratch dir containing one deliberately bad sql exercise (identical expectedRows in both cases — note: the schema already rejects it, so construct the in-memory object bypassing `loadBank` for the gate-logic unit, or use a fixture with two distinct-but-cheesable cases where the cheese passes both → gate must fail). Delete the scratch after.
- [ ] **Step 3: Verify + commit.** `npm test` green (sql gates vacuous-but-armed on the built-in bank until Task 6). `git commit -m "test(bank): sql integrity gates (fixture, distinct cases, anti-hardcode, determinism)"`.

### Task 6: Built-in sql statics (3) + guard sql arm

**Files:**
- Create: `bank/exercises/syntax-recall/sr-sql-001.json`, `sr-sql-002.json`, `sr-sql-003.json`
- Modify: `bank/bank-integrity.test.ts` (add the `sqlWrites.length > 0` built-in arm — same commit, per spec §3.5)

**Contracts** (generic, non-DeShaw schemas; tier/soft-min; every drill ≥ 2 cases, distinct rows; reference graded 1.00 pre-commit):
- `sr-sql-001` (tier 1, 5 min): GROUP BY + HAVING — orders table, "customers with ≥ 2 orders and their order counts", alias `orders_count`. Case 2 changes which customers clear the threshold.
- `sr-sql-002` (tier 2, 8 min): window function — "each employee with the rank of their salary within their department" via `DENSE_RANK() OVER (PARTITION BY dept ORDER BY salary DESC)`, alias `rnk`. Case 2 includes a salary tie proving DENSE_RANK (a RANK solution produces different rows — encode the tie so the two functions disagree).
- `sr-sql-003` (tier 2, 8 min): anti-join — "customers with no orders" (LC-175-shaped but generic names), accepting `LEFT JOIN … IS NULL`, `NOT IN` (fixture keeps `NULL`-free keys so NOT IN is safe), or `NOT EXISTS` — all three must grade 1.00 (record all three gradings in the report).

- [ ] Steps: author → grade references through real CLI (`ATROPHY_NO_SYNC=1`, throwaway DB, `--solution`) → `npx vitest run bank/bank-integrity.test.ts` (sql gates now non-vacuous; add the guard arm) → `npm test` → commit `feat(bank): built-in sql statics + sql vacuity arm`.

### Task 7: SQL pack — LeetCode set (8 drills)

**Files:** Create under `Java-OAs/atrophy-pack/exercises/` (follow the pack's existing axis-folder layout): `sql-combine-two-tables`, `sql-employees-earning-more-than-managers`, `sql-duplicate-emails`, `sql-second-highest-salary`, `sql-consecutive-numbers`, `sql-department-highest-salary`, `sql-department-top-three-salaries`, `sql-nth-highest-salary` — ids = slugs, axis `syntax-recall`, kind `write`, language `sql`, tiers/soft-mins per the manifest rows (§5.1).

**Per-drill requirements:**
- Fixtures follow each LC problem's canonical schema (Person/Address, Employee, Person(email), Employee/Department, Logs). ≥ 2 cases each; the second case must flip the qualitative answer (different winners, an empty result, a tie).
- `sql-second-highest-salary`: case with < 2 distinct salaries expects `[{ SecondHighestSalary: null }]` — the classic trap; both the subquery form and the `DENSE_RANK` form must grade 1.00 (grade BOTH references, record both).
- `sql-nth-highest-salary`: N is pinned to 3 in the prompt (no parameterization in this modality); a case with fewer than 3 distinct salaries expects `null` per the LC contract.
- `sql-consecutive-numbers` (the CodePair-confirmed headliner): three-consecutive-same-number via self-join or window `LAG`/`LEAD` — both reference forms graded 1.00; expected column `ConsecutiveNums` DISTINCT.
- `sql-department-top-three-salaries`: `DENSE_RANK` per department ≤ 3; a case with intra-department salary ties.
- Prompts state: SQLite dialect, required output column names, whether order matters (all 8 are `ordered` absent).
- [ ] Steps: author all 8 → pack integrity (`$env:ATROPHY_BANK="C:\Users\gurms\IdeaProjects\Java-OAs\atrophy-pack"; npx vitest run bank/bank-integrity.test.ts`) → grade every reference (and the named alternates) 1.00 via CLI → commit in Java-OAs by name with message `feat(pack): sql wave 1 of 2 — LC set (8 drills)`.

### Task 8: SQL pack — trading set (4) + syntax-fact drills (3)

**Files:** Create in the pack: `sql-daily-pnl-by-trader` (t2), `sql-first-login-per-user` (t1), `sql-consecutive-position-increases` (t3), `sql-trades-deviating-from-benchmark` (t3) as sql writes; plus `sql-rank-window-functions` (cloze, multi-blank: one snippet with `____` for RANK/DENSE_RANK/ROW_NUMBER outputs on a fixed tie dataset), `sql-lag-lead-recall` (recall: "which function reads the previous row's value within the partition — name only"), `sql-partition-by-cloze` (cloze: `OVER (____ dept ORDER BY ts)`).

**Per-drill requirements:**
- `sql-first-login-per-user`: BOTH canonical forms (GROUP BY MIN and `ROW_NUMBER() = 1`) grade 1.00 (doc supplies both — grade both).
- `sql-consecutive-position-increases`: gaps-and-islands via `ROW_NUMBER` difference; case 2 has a single-row island and a boundary-touching island.
- `sql-trades-deviating-from-benchmark`: z-score **via the variance identity** — `AVG(x*x) - AVG(x)*AVG(x)` and `sqrt()` (availability proven by Task 3's probe test); threshold |z| > 2 pinned in the prompt; expected rows avoid float-representation traps (choose data where z-scores are unambiguous, no equality-with-epsilon needed — e.g. deviations at 0.5σ and 3σ).
- Syntax-fact drills carry the L154 convention: prompts state the expected answer form.
- [ ] Steps: author → pack integrity → reference-grade all (both first-login forms) → commit `feat(pack): sql wave 2 of 2 — trading set + syntax facts (7 drills)`.

### Task 9: Recall dozen (12 pack drills)

**Files:** Create in the pack (axis per manifest row): `c01-synchronized-forms`, `c08-latch-barrier-semaphore`, `b01-collections-bigO`, `b02-algorithm-complexities`, `b03-sorting-in-java`, `b04-n-budget-heuristic`, `atomiclong-vs-longadder`, `jstat-read`, `gclog-parse`, `jstack-deadlock-read`, `async-profiler-recipes`, `jvm-flags-recall`.

**Requirements:** kind per manifest (`recall`, answer-match). `b01-collections-bigO` uses **multi-blank cloze** (Task 2) for the complexity grid — normalize `O(n log n)` vs `O(nlogn)` by including both in each blank's accepted set (the manifest's normalization note becomes accepted-set enumeration; also accept `O(log n)`/`O(logn)` pairs). Every prompt states the expected answer form (L154). Numeric answers rely on the engine's numeric tolerance; name answers enumerate synonyms. No fact verbatim-duplicated from built-in drills (a02/a05/a10-class rule — check each against the built-in api/cr java statics and note the check per drill in the report).
- [ ] Steps: author → pack integrity → self-grade each via `--solution` (recall/cloze accept solution files) → commit `feat(pack): recall dozen — concurrency, complexity, JVM tooling`.

### Tasks 10–12: Freq-confirmed wave-2 set (38 java drills, three domain tasks)

All are pack java drills; kind/tier/soft-min/axis per each manifest row (wave-2 tables); json-tests `write` unless the row says harness/op-driver (op-driver rows follow the Plan B op-driver pattern: `tests` drive an operation sequence through the graded method). Global Constraints' java rules + reference-grading apply to every drill. Each task: author → pack integrity → reference-grade each drill 1.00 → by-name commit.

- **Task 10 — arrays/strings/matrix (13):** `insert-delete-getrandom`, `product-except-self`, `group-anagrams`, `maximum-product-subarray`, `top-k-frequent`, `minimum-window-substring`, `sliding-window-maximum`, `trapping-rain-water`, `basic-calculator`, `n-queens`, `josephus-problem`, `spiral-matrix`, `search-2d-matrix-ii`. Commit `feat(pack): w2 freq set — arrays/strings/matrix (13)`.
- **Task 11 — DP (9):** `knapsack-01`, `house-robber`, `best-time-stock-ii`, `best-time-stock-iii`, `best-time-stock-iv`, `painting-the-walls`, `longest-increasing-path-matrix`, `champagne-tower`, `super-egg-drop`. Tests must defeat the classic wrong-loop-order/greedy cheeses (each drill's brief-row names its trap vector; e.g. stock-iii needs a case where two disjoint transactions beat one big one). Commit `feat(pack): w2 freq set — DP (9)`.
- **Task 12 — trees/graphs/design structures (16):** `count-inversions-reverse-pairs`, `kth-smallest-multiplication-table`, `copy-list-with-random-pointer`, `car-fleet`, `alien-dictionary`, `binary-tree-cameras`, `maximum-sum-bst`, `skip-list`, `red-black-tree-insertion`, `two-four-tree-ops`, `find-median-data-stream`, `single-threaded-cpu`, `design-leaderboard`, `weighted-prefix-search`, `fenwick-xor-range`, `articulation-points-scratch`. Structure drills (skip-list, RB, 2-4, median, leaderboard, prefix, fenwick) are op-drivers; `red-black-tree-insertion`/`two-four-tree-ops` verify structural invariants through observable ops (ordered traversal + size/height bounds), never internal field peeking. Commit `feat(pack): w2 freq set — trees/graphs/design (16)`.

### Task 13: Named W2 concurrency build drills (7, pack)

**Files:** `prodcons-waitnotify`, `bounded-blocking-queue`, `singleton-five-ways`, `chm-internals-explain`, `c04-readwritelock-jdk`, `reentrantlock-vs-sync`, `happens-before-six` — kinds per manifest rows (harness kinds for the behavioral ones; `chm-internals-explain`/`happens-before-six`/`reentrantlock-vs-sync` are recall/outline per their rows).

**Requirements:** every Plan B harness convention (Global Constraints block) applies; watchdogs well under `testTimeoutMs`; deadline-race margins ≥ 2×. **Overlap ruling required in-task before authoring `bounded-blocking-queue`:** compare against built-in `dec-java-005` (bounded queue) — if the graded surface would duplicate it, reframe (different ops mix, semaphore-based contract, or timeout-put semantics) and record the ruling in the report. Same check: `c04-readwritelock-jdk` vs built-in `sr-java-003` rwlock-from-scratch (JDK-API drill vs build-from-scratch is a legitimate distinction — state it).
- [ ] Steps: author → pack integrity (harness starters 0/N by running) → reference-grade 1.00 each → commit `feat(pack): named W2 concurrency drills (7)`.

### Task 14: Wave-3 breadth picks (18, pack)

**Files:** 9 predict-output: `po-erasure-getclass`, `po-bigdecimal-equals-vs-compareto`, `po-tolist-immutable`, `po-stream-single-use`, `po-record-generated`, `po-instanceof-pattern-bind`, `po-switch-expression-arrow`, `po-string-concat-loop-identity`, `po-wrong-monitor-wait`; 9 fix: `fix-equals-missing-hashcode`, `fix-wait-if-not-while`, `fix-notify-vs-notifyall`, `fix-unlock-outside-finally`, `fix-dcl-missing-volatile`, `fix-mutable-hashmap-key`, `fix-cme-remove-during-iteration`, `fix-binary-search-mid-overflow`, `fix-volatile-counter`.

**Requirements:** predict snippets must run cleanly and deterministically (integrity-enforced); `po-string-concat-loop-identity` prints identity CHANGES (boolean `s1 == s2` per pass), never raw hashcodes; `po-wrong-monitor-wait` prints the caught `IllegalMonitorStateException` name (deterministic), it does not hang. Fix drills: planted bug must fail a test (integrity-enforced); concurrency fixes (`fix-wait-if-not-while`, `fix-notify-vs-notifyall`, `fix-dcl-missing-volatile`, `fix-volatile-counter`) are `fix-harness` with Plan B conventions; the rest are plain `fix` with deterministic tests. **Overlap rulings in-task:** each drill vs the shipped `dbg-java-00x`/`cr-java-00x` statics and the `dbg-java-scan`/`cr-java-trace` generator families (the comparator-subtraction trap is already family-covered — that is why it is not in this list; verify none of the 18 collides the same way, record per-drill).
- [ ] Steps: author → pack integrity → reference-grade → commit `feat(pack): wave-3 breadth — predict/fix (18)`.

### Task 15: Pack manifest + coverage bookkeeping

**Files:** Modify `Java-OAs/atrophy-pack/DRILL-MANIFEST.md` (mark shipped rows wave→"shipped plan-C", note the frozen wave-3 pick list and the two syntax-fact additions), and the pack's README/index if one exists.

- [ ] Steps: annotate rows for every drill shipped in Tasks 7–14 → sanity-grep that every shipped slug appears exactly once as shipped → commit `docs(pack): manifest bookkeeping for plan-C slice`.

### Task 16: Wrap — merged verification, smoke, docs

**Files:** Modify `README.md` (five-skills table reconciled with shipped kinds — Decomposition row lists write/write-harness alongside outline; api row acknowledges cloze/write-harness/recall; sql sentence), `CLAUDE.md` (sql modality + multi-blank cloze one-liners in the bank/engine sections).

- [ ] **Step 1:** Full merged run: base integrity, pack integrity (`ATROPHY_BANK`), merged doctor (`ATROPHY_PACKS` — expect 58 + this plan's pack drills, zero collisions), `npm test`, `npm run typecheck`.
- [ ] **Step 2:** `npm run build` + built-CLI smoke (`node dist/cli/index.js`, `ATROPHY_NO_SYNC=1`, throwaway DB): one behavioral sql drill (reference 1.00, hardcode-cheese < 1.00), one multi-blank cloze (partial credit observed, e.g. 1 of 2 blanks → 0.5 of the cloze unit), one java drill per new content task family (Tasks 10–14: one each), `drill --lang sql --show` axis-pick works.
- [ ] **Step 3:** Docs edits; `npm run typecheck` still clean.
- [ ] **Step 4:** Commit `docs: plan C wrap — sql + slice shipped`. Pack repo gets a commit only if smoke found a broken drill (`fix(pack):` naming it).

---

## Execution order

Tasks 1 → 2 → 3 are sequential (schema → cloze → grader). Task 4 and Task 5 can follow in either order (both consume Tasks 1/3). Task 6 requires 1+3+5. Tasks 7–14 are independent of each other once 1–6 are merged (parallelize per Plan B's worktree pattern; content tasks touching only the pack repo need no atrophy worktree at all). Task 15 needs 7–14. Task 16 is last.

## Self-Review (performed at write time)

**Spec coverage:** §2.1 schema → Task 1; §2.2 grader → Task 3; §2.3 session/CLI/doctor → Tasks 2–3; §2.4 gates → Task 5 (+ Task 6 guard arm; reference-grading in every content task); §2.5 non-goals → no task builds them; §3.1 → Global Constraints (scan ≤ behavioral); §3.2 → Task 2; §3.3/3.4/3.5 → Task 4 (+6); §3.6 conventions → embedded in Tasks 9, 13, 14 requirements; §4 slice buckets 1–6 → Tasks 7–8 (12 behavioral + 3 syntax-fact = the "~8 + ~5 split" resolved to 12+3 within the spec's authoring latitude — all 12 §5.1 drills are query-writing, so all grade behaviorally), Task 6 (built-ins), Tasks 10–12 (38 freq), Task 13 (7 named), Task 9 (12 recall), Task 14 (18 picks; ~20 trimmed to 18 by the family-overlap exclusions, recorded); §5 testing → per-task steps + Task 16; §6 execution → Execution order + Global Constraints. Slice arithmetic: 12+3+3+38+7+12+18 = 93 shipped drills (92 pack + built-ins net of any dedupe rulings in Tasks 13/14) — inside the spec's ~85–92 band allowing for 1–2 fold-ins.
**Placeholder scan:** clean — every task carries concrete slugs, shapes, or code; content tasks follow the Plan B contract-row pattern deliberately (full JSON bodies are authored in-task under integrity + reference-grading gates).
**Type consistency:** `isSqlWrite`/`SqlWriteExercise`/`canonicalRows`/`JVM_KINDS` (Task 1) are the names used in Tasks 3, 4, 5; `countBlanks`/`gradeCloze`/`acceptedForBlank` (Task 2) used in Task 9's b01; `grade` entry-point name flagged as adapt-to-real in Tasks 3/5 (single deliberate adaptation point, called out in both).
