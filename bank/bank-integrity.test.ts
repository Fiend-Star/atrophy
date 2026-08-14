import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { grade, gradePrediction, normalizeRecallAnswer, solutionFileName } from "../engine/grader.js";
import { JAVA_COMPILE_TIMEOUT_MS, hasJdk, javacCommand } from "../engine/javatool.js";
import { run } from "../engine/runner.js";
import {
  JVM_KINDS,
  canonicalRows,
  countBlanks,
  isHarness,
  isSqlWrite,
  loadBank,
  spawnsJvm,
  type ClozeExercise,
  type CodeLikeExercise,
  type PredictExercise,
  type SqlWriteExercise,
} from "./schema.js";

const here = fileURLToPath(new URL(".", import.meta.url));
/**
 * Any bank dir can be validated, not just the built-in one - this is how a pack
 * gets checked before it is trusted: `ATROPHY_BANK=<pack-dir> npx vitest run
 * bank/bank-integrity.test.ts`. Like the CLI, the variable replaces the bank rather
 * than adding to it; unlike the CLI, an empty value is not read as "unset" - it
 * fails loudly here instead of silently validating the built-in bank.
 */
const bankRoot = process.env.ATROPHY_BANK ?? join(here, "exercises");
const bank = loadBank(bankRoot);
const validatingBuiltInBank = !process.env.ATROPHY_BANK;

/**
 * Everything outside the JDK-gated describe below must be runnable without a JDK,
 * so java content is filtered out of every loop that spawns a toolchain.
 */
const nonJava = bank.filter((e) => e.language !== "java");

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "atrophy-bank-"));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("bank integrity", () => {
  it("the bank root holds exercises at all", () => {
    // An existing-but-exercise-less dir loads as [] without throwing, and every loop
    // below then passes by iterating nothing: a pack author would read that green as
    // "my pack is valid". This is the one check no bank of any shape may skip.
    expect(bank.length, `no exercises found under ${bankRoot}`).toBeGreaterThan(0);
  });

  it("every fix exercise ships a bug that actually fails at least one test", async () => {
    const fixes = nonJava.filter((e) => e.kind === "fix");
    // The built-in bank losing its fixes would silently make this test vacuous. A pack
    // pointed at by ATROPHY_BANK may legitimately be pure-java (validated under the JDK
    // gate below) or ship no fix exercises at all, so it is not held to that.
    if (validatingBuiltInBank) expect(fixes.length).toBeGreaterThan(0);
    for (const ex of fixes) {
      const dir = scratch();
      writeFileSync(join(dir, solutionFileName(ex)), ex.starterCode, "utf8");
      const r = await grade(ex, dir);
      expect(r.passed, `${ex.id}: planted bug passes all tests - no bug to find`).toBeLessThan(r.total);
      expect(r.passed + (r.harnessError ? 0 : 1), `${ex.id}: starter should at least load`).toBeGreaterThan(0);
    }
  }, 120_000);

  it("every predict-output snippet runs cleanly and deterministically", async () => {
    const predicts = nonJava.filter((e) => e.kind === "predict-output");
    for (const ex of predicts) {
      const first = await gradePrediction(ex, scratch(), "");
      expect(first.error, `${ex.id}: ${first.error}`).toBeUndefined();
      expect(first.actual, `${ex.id}: snippet prints nothing`).toBeTruthy();
      const second = await gradePrediction(ex, scratch(), first.actual!);
      expect(second.correct, `${ex.id}: output is not deterministic`).toBe(true);
    }
  }, 120_000);

  it("cloze blanks actually appear in their snippets, and per-blank sets match them", () => {
    for (const ex of bank.filter((e): e is ClozeExercise => e.kind === "cloze")) {
      const blanks = countBlanks(ex.snippet);
      expect(blanks, `${ex.id}: snippet has no ____ blank`).toBeGreaterThan(0);
      // Only the nested shape has a count to check. The flat shape deliberately has none:
      // one set fills however many blanks there are, which is what several shipped
      // exercises rely on (two blanks, one shared set of answers).
      if (Array.isArray(ex.acceptedAnswers[0])) {
        expect(
          ex.acceptedAnswers.length,
          `${ex.id}: per-blank acceptedAnswers needs one set per ____ blank (blanks: ${blanks})`,
        ).toBe(blanks);
      }
    }
  });

  it("every recall answer still says something after normalization", () => {
    // The schema only demands a non-empty string, so " " gets through - and grading
    // compares normalized forms, which would make such an answer unmatchable by anyone.
    for (const ex of bank.filter((e) => e.kind === "recall")) {
      for (const accepted of ex.acceptedAnswers) {
        const { text } = normalizeRecallAnswer(accepted);
        expect(text, `${ex.id}: accepted answer ${JSON.stringify(accepted)} normalizes to nothing`).not.toBe("");
      }
    }
  });
});

/** Grade one hand-written query exactly the way a submission is graded (subprocess and all). */
async function gradeSqlSource(ex: SqlWriteExercise, sql: string) {
  const dir = scratch();
  writeFileSync(join(dir, solutionFileName(ex)), sql, "utf8");
  return grade(ex, dir);
}

/** A SQLite literal for one expected value - the building block of the hardcode cheese. */
function sqlLiteral(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return `'${String(value).replace(/'/g, "''")}'`;
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Integers past this are already a different number by the time JSON.parse is done. */
const MAX_EXACT_INTEGER = 2 ** 53;

/**
 * Everything a fixture built: its schema, plus every user table's contents canonicalized
 * the way a result set is. Two fixtures that produce the same snapshot produce the same
 * database, whatever order the rows went in.
 */
function fixtureSnapshot(fixture: string): string {
  const db = new Database(":memory:");
  try {
    db.exec(fixture);
    const schema = db
      .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
      .all() as { type: string; name: string; sql: string | null }[];
    const data = schema
      .filter((o) => o.type === "table" && !o.name.startsWith("sqlite_"))
      .map((t) => [
        t.name,
        canonicalRows(db.prepare(`SELECT * FROM ${quoteIdent(t.name)}`).all() as Record<string, unknown>[]),
      ]);
    return JSON.stringify([schema, data]);
  } finally {
    db.close();
  }
}

/**
 * sql needs no toolchain gate the way java does - better-sqlite3 is a dependency of the
 * CLI itself, so any machine that can run atrophy can validate sql content, and every
 * pack validated through ATROPHY_BANK is held to these gates as well. What keeps them
 * from passing on an empty loop is the presence arm below (spec §3.5).
 */
describe("bank integrity - sql", () => {
  const sqlWrites = bank.filter(isSqlWrite);

  it("the built-in bank ships sql write content", () => {
    // spec §3.5's third vacuity arm, beside the two java ones above. Every gate in this
    // describe iterates sqlWrites, so a bank that lost its sql would turn all of them
    // green by iterating nothing. A pack pointed at by ATROPHY_BANK may legitimately ship
    // no sql at all, so only the built-in bank is held to this.
    if (!validatingBuiltInBank) return;
    expect(sqlWrites.length, "built-in bank ships no sql write content").toBeGreaterThan(0);
  });

  it("every fixture applies cleanly and builds the same database twice", () => {
    for (const ex of sqlWrites) {
      for (const [i, c] of ex.cases.entries()) {
        const where = `${ex.id} case ${i + 1}`;
        // A fixture that will not apply voids the whole attempt at grade time (gradeSql
        // reports an exercise bug rather than a score), so the user gets nothing at all.
        const build = () => {
          try {
            return fixtureSnapshot(c.fixture);
          } catch (err) {
            throw new Error(`${where}: fixture does not apply cleanly: ${(err as Error).message}`);
          }
        };
        // Twice, into two fresh databases: a fixture that seeds with random() or now()
        // expects rows that are only right on some runs.
        expect(build(), `${where}: fixture builds a different database on a second run`).toBe(build());
      }
    }
  });

  it("at least two cases expect different rows", () => {
    // The schema refuses this at parse time; re-asserted here because it is the premise
    // every other sql gate leans on - one indistinguishable pair and the drill is
    // answerable by a literal.
    for (const ex of sqlWrites) {
      const canon = new Set(ex.cases.map((c) => canonicalRows(c.expectedRows)));
      expect(canon.size, `${ex.id}: every case expects the same rows`).toBeGreaterThan(1);
    }
  });

  it("every expected value is a value SQLite can return, and integers stay exact", () => {
    for (const ex of sqlWrites) {
      for (const [i, c] of ex.cases.entries()) {
        for (const row of c.expectedRows) {
          for (const [column, value] of Object.entries(row)) {
            const where = `${ex.id} case ${i + 1}, column ${column}`;
            // canonicalRows sorts top-level keys only, so a nested object's own key order
            // would decide equality - and no SQLite column returns an object or an array
            // anyway, so such a value is unmatchable by any query.
            // A JSON boolean is rejected for the same reason: better-sqlite3 hands back
            // SQLite's 1/0 integers and never a JS boolean, so `true` in an expectedRow is
            // an answer no query can give. On an unordered drill the cheese gate below
            // catches it (the source case stops reproducing itself), but that arm is
            // skipped when `ordered` is set - so for an ordered drill this is the only
            // gate standing between a boolean and an unwinnable exercise.
            const scalar = value === null || typeof value === "string" || typeof value === "number";
            expect(
              scalar,
              `${where}: expected values must be a string, a number or null - SQLite returns nothing else, got ${JSON.stringify(value)}`,
            ).toBe(true);
            if (typeof value !== "number") continue;
            expect(Number.isFinite(value), `${where}: ${String(value)} is not a finite number`).toBe(true);
            // Same rule as java's `tests`: the exercise JSON goes through Node's JSON.parse
            // long before grading, so a bigger integer is already a different number here.
            if (Number.isInteger(value)) {
              expect(
                Math.abs(value),
                `${where}: integer ${value} is past 2^53 and cannot round-trip`,
              ).toBeLessThanOrEqual(MAX_EXACT_INTEGER);
            }
          }
        }
      }
    }
  });

  it("the hardcoded-literal cheese cannot pass every case", async () => {
    for (const ex of sqlWrites) {
      // spec §2.4(c): the cheese is rebuilt from the FIRST case that expects any rows.
      // A bank where no case does is already impossible - the gate above rejects it.
      const sourceIndex = ex.cases.findIndex((c) => c.expectedRows.length > 0);
      const source = ex.cases[sourceIndex];
      expect(source, `${ex.id}: every case expects zero rows - nothing to hardcode from`).toBeDefined();
      if (!source) continue;
      const columns = Object.keys(source.expectedRows[0] ?? {});
      expect(columns.length, `${ex.id}: case ${sourceIndex + 1} expects rows with no columns`).toBeGreaterThan(0);
      const cheese = source.expectedRows
        .map((row) => `SELECT ${columns.map((c) => `${sqlLiteral(row[c])} AS ${quoteIdent(c)}`).join(", ")}`)
        .join(" UNION ALL ");

      const r = await gradeSqlSource(ex, cheese);
      // Without these two, the gate below passes on a cheese that never ran: a broken
      // fixture (harnessError) or a cheese SQLite refuses to parse both score 0.
      expect(r.harnessError, `${ex.id}: ${r.harnessError}`).toBeUndefined();
      for (const f of r.failures) {
        // A case expecting 501+ rows builds a cheese past SQLITE_MAX_COMPOUND_SELECT (500
        // UNION ALL terms), which SQLite will not parse - this arm then reds carrying the
        // parse error as its message. That red is the design working, not a gate bug: an
        // uncheesable exercise is one this net cannot cover, so it wants smaller cases.
        expect(f.error, `${ex.id}: the cheese did not run as a query: ${f.error}`).toContain("wrong rows");
      }
      if (!ex.ordered) {
        // The cheese is this case's own rows, written out as literals, so it must
        // reproduce it. When it does not, an expected value is one no query can return
        // either (a JSON `true` comes back from SQLite as 1) - unmatchable, not cheese-proof.
        // Skipped for ordered drills only because UNION ALL's row order is unspecified.
        expect(
          r.failures.map((f) => f.index),
          `${ex.id}: case ${sourceIndex + 1}'s own rows as literals do not reproduce it`,
        ).not.toContain(sourceIndex);
      }
      // The letter of §2.4(c). The distinct-cases rule above already implies it - fixed
      // rows can match at most one of two distinct expectations - so this stays as the
      // statement of intent, and the two checks above are what actually catch a bad bank.
      expect(r.passed, `${ex.id}: a hardcoded literal passes every case`).toBeLessThan(ex.cases.length);
    }
  }, 120_000);
});

const javaCode = bank.filter(
  (e): e is CodeLikeExercise => JVM_KINDS.some((k) => k === e.kind) && e.language === "java",
);
const javaPredicts = bank.filter(
  (e): e is PredictExercise => e.kind === "predict-output" && e.language === "java",
);

/**
 * The schema's 10s default `testTimeoutMs` is a flake factory once javac + JVM startup
 * are on the clock, so java content whose grading starts a JVM (`spawnsJvm`: the
 * compiled kinds plus predict-output) is held to a floor. Static JSON only - this lint
 * spawns nothing and stays ungated.
 */
describe("java timeout floors", () => {
  const javaJvm = bank.filter((ex) => ex.language === "java" && spawnsJvm(ex.kind));

  it("the built-in bank ships java content of both graded shapes", () => {
    // Every java check in this file - the floors here and the whole JDK-gated describe
    // below - iterates one of these two sets, so losing the shipped java content would
    // turn all of them green by iterating nothing. Per-kind rather than one combined
    // count, because they gate different loops: the compiled kinds gate starter
    // compilation and planted bugs, predict-output gates snippet determinism, and a
    // bank keeping only one of them would leave the other's loop silently vacuous.
    // A pack pointed at by ATROPHY_BANK may legitimately ship no java, so only the
    // built-in bank is held to this. (The third arm of the same guard, sql, lives with
    // the gates it protects: "the built-in bank ships sql write content" above.)
    if (!validatingBuiltInBank) return;
    expect(javaCode.length, "built-in bank ships no java write/fix/harness content").toBeGreaterThan(0);
    expect(javaPredicts.length, "built-in bank ships no java predict-output content").toBeGreaterThan(0);
  });

  it("every JVM-spawning java exercise allows at least 20s", () => {
    const bad = javaJvm.filter((ex) => ex.testTimeoutMs < 20_000);
    expect(bad.map((ex) => `${ex.id}: ${ex.testTimeoutMs}`)).toEqual([]);
  });

  it("tier-3 harness drills allow at least 30s", () => {
    // Harness drills run the exercise's own checks (threads, latches, watchdog) on top
    // of compile + startup; the hardest tier needs the extra headroom.
    const bad = javaJvm.filter((ex) => isHarness(ex) && ex.tier === 3 && ex.testTimeoutMs < 30_000);
    expect(bad.map((ex) => `${ex.id}: ${ex.testTimeoutMs}`)).toEqual([]);
  });
});

// Java content is validated only where a toolchain exists; the presence check above
// guarantees the built-in bank keeps these loops non-empty.
// Generated java families ship no JSON and so never reach this bank, but they reach the
// same grader: their copy of these gates lives beside the other generator contracts,
// in bank/generators/generators.test.ts ("generator contracts - java").
if (!hasJdk()) console.warn("⚠ JDK not found - Java exercises NOT validated. Install JDK 21.");
describe.skipIf(!hasJdk())("bank integrity - java", () => {
  it("every java starter compiles (no javac vomit on first submit)", async () => {
    for (const ex of javaCode) {
      const dir = scratch();
      writeFileSync(join(dir, solutionFileName(ex)), ex.starterCode, "utf8");
      // Same locale pin as the grader's javac call, so a failure reads the same everywhere.
      const r = await run(
        javacCommand(),
        ["-J-Duser.language=en", "-J-Duser.country=US", "-encoding", "UTF-8", solutionFileName(ex)],
        { cwd: dir, timeoutMs: JAVA_COMPILE_TIMEOUT_MS },
      );
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
    for (const ex of javaPredicts) {
      const first = await gradePrediction(ex, scratch(), "");
      expect(first.error, `${ex.id}: ${first.error}`).toBeUndefined();
      expect(first.actual, `${ex.id}: snippet prints nothing`).toBeTruthy();
      const second = await gradePrediction(ex, scratch(), first.actual!);
      expect(second.correct, `${ex.id}: output is not deterministic`).toBe(true);
    }
  }, 300_000);
});
