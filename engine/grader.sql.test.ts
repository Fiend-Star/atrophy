import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalRows, exerciseSchema, isSqlWrite, type SqlWriteExercise } from "../bank/schema.js";
import { grade, SQL_CANON_SOURCE, solutionFileName } from "./grader.js";

// No skipIf anywhere in here, unlike the java suites: better-sqlite3 is a dependency of
// the CLI itself, so a machine that can run atrophy at all can grade sql.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Parse a fixture and narrow it - never assert - so the sql shape is proved, not claimed. */
function sqlExercise(raw: unknown): SqlWriteExercise {
  const parsed = exerciseSchema.parse(raw);
  if (!isSqlWrite(parsed)) throw new Error(`fixture is not a sql write: ${parsed.id}`);
  return parsed;
}

const ex = sqlExercise({
  id: "sr-sql-902", axis: "syntax-recall", tier: 1, title: "t", prompt: "sum per key", softTimeLimitSeconds: 60,
  kind: "write", language: "sql", starterCode: "-- SELECT ...",
  cases: [
    { fixture: "CREATE TABLE t(k TEXT, v INT); INSERT INTO t VALUES ('a',1),('a',2),('b',5);", expectedRows: [{ k: "a", s: 3 }, { k: "b", s: 5 }] },
    { fixture: "CREATE TABLE t(k TEXT, v INT); INSERT INTO t VALUES ('z',7);", expectedRows: [{ k: "z", s: 7 }] },
  ],
});

/** Write an answer into a fresh scratch dir and hand back the dir `grade` works in. */
const solve = (sql: string) => {
  const d = mkdtempSync(join(tmpdir(), "atrophy-sql-"));
  dirs.push(d);
  writeFileSync(join(d, solutionFileName(ex)), sql, "utf8");
  return d;
};

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
    const probe = sqlExercise({ ...ex, id: "sr-sql-903", cases: [
      { fixture: "CREATE TABLE n(x REAL); INSERT INTO n VALUES (4.0),(9.0);", expectedRows: [{ r: 2.0 }, { r: 3.0 }] },
      { fixture: "CREATE TABLE n(x REAL); INSERT INTO n VALUES (16.0);", expectedRows: [{ r: 4.0 }] },
    ]});
    const r = await grade(probe, solve("SELECT sqrt(x) AS r, ROW_NUMBER() OVER (ORDER BY x) AS rn FROM n")); // rn unused in expected → this variant must FAIL
    expect(r.passed).toBe(0);
    const r2 = await grade(probe, solve("SELECT sqrt(x) AS r FROM n"));
    expect(r2.passed).toBe(2);
  });
});

describe("sql grading - reporting", () => {
  it("a broken query is the user's failure, not a harness error", async () => {
    // The distinction is load-bearing: a harnessError abandons the drill (nothing
    // recorded), so mislabelling a syntax error that way would lose the rep.
    const r = await grade(ex, solve("SELEC nope"));
    expect(r.harnessError).toBeUndefined();
    expect(r.total).toBe(2);
    expect(r.failures).toHaveLength(2);
    // No args: printFailures renders these as named checks, so the message is all the
    // user sees - it has to name the case and say what SQLite objected to.
    expect(r.failures[0]?.args).toBeUndefined();
    expect(r.failures[0]?.error).toContain("case 1:");
    expect(r.failures[0]?.error).toContain("SELEC");
  });
  it("a wrong result set reports expected vs got", async () => {
    const r = await grade(ex, solve("SELECT k, SUM(v) AS total FROM t GROUP BY k"));
    expect(r.harnessError).toBeUndefined();
    expect(r.failures[0]?.error).toContain("wrong rows");
    expect(r.failures[0]?.error).toContain("expected");
    expect(r.failures[0]?.error).toContain("total");
  });
  it("a clean pass reports no failures and no harness error", async () => {
    const r = await grade(ex, solve("SELECT k, SUM(v) AS s FROM t GROUP BY k"));
    expect(r.harnessError).toBeUndefined();
    expect(r.failures).toEqual([]);
  });
  it("the answer is graded read-only: a mutating solution cannot rewrite the fixture", async () => {
    const r = await grade(ex, solve("DELETE FROM t"));
    expect(r.passed).toBe(0);
    expect(r.harnessError).toBeUndefined();
    expect(r.failures[0]?.error).toMatch(/readonly|does not return data/i);
  });
});

describe("sql grading - ordered", () => {
  const orderedEx = sqlExercise({
    id: "sr-sql-904", axis: "syntax-recall", tier: 1, title: "t", prompt: "keys, ascending",
    softTimeLimitSeconds: 60, kind: "write", language: "sql", starterCode: "-- SELECT ...", ordered: true,
    cases: [
      { fixture: "CREATE TABLE t(k TEXT); INSERT INTO t VALUES ('b'),('a');", expectedRows: [{ k: "a" }, { k: "b" }] },
      { fixture: "CREATE TABLE t(k TEXT); INSERT INTO t VALUES ('z'),('y');", expectedRows: [{ k: "y" }, { k: "z" }] },
    ],
  });

  it("fails the right rows in the wrong order", async () => {
    const r = await grade(orderedEx, solve("SELECT k FROM t ORDER BY k DESC"));
    expect(r.passed).toBe(0);
    expect(r.failures[0]?.error).toContain("wrong rows");
  });
  it("passes the same rows in the declared order", async () => {
    const r = await grade(orderedEx, solve("SELECT k FROM t ORDER BY k"));
    expect(r.passed).toBe(2);
  });
});

describe("sql grading - window functions evaluate", () => {
  it("ROW_NUMBER() OVER () actually produces the numbering", async () => {
    // The probe above only proves the query *parsed*: an unsupported window function
    // would also score 0 there. This one has to compute the right numbers to pass.
    const windowEx = sqlExercise({
      id: "sr-sql-905", axis: "syntax-recall", tier: 2, title: "t", prompt: "number the rows",
      softTimeLimitSeconds: 60, kind: "write", language: "sql", starterCode: "-- SELECT ...",
      cases: [
        { fixture: "CREATE TABLE n(x INT); INSERT INTO n VALUES (9),(5);", expectedRows: [{ x: 5, rn: 1 }, { x: 9, rn: 2 }] },
        { fixture: "CREATE TABLE n(x INT); INSERT INTO n VALUES (3);", expectedRows: [{ x: 3, rn: 1 }] },
      ],
    });
    const r = await grade(windowEx, solve("SELECT x, ROW_NUMBER() OVER (ORDER BY x) AS rn FROM n"));
    expect(r.passed).toBe(2);
  });
});

describe("SQL_CANON_SOURCE", () => {
  it("matches the schema's canonicalRows byte for byte", () => {
    // The harness runs in a child process and cannot import the schema, so the only
    // thing keeping the two definitions together is this comparison. Nested values are
    // stringified as-is by both - only top-level keys and row order are canonicalized.
    const canon = new Function(`${SQL_CANON_SOURCE}\nreturn canonicalRows;`)() as (
      rows: readonly Record<string, unknown>[],
      ordered: boolean,
    ) => string;
    const rows = [
      { b: { z: 1, a: 2 }, a: "x", c: [3, { n: null }] },
      { a: "y", c: [], b: { a: 2, z: 1 } },
    ];
    expect(canon(rows, false)).toBe(canonicalRows(rows));
    expect(canon([...rows].reverse(), false)).toBe(canonicalRows(rows));
    // ...and ordered is the one thing that differs: same rows, other sequence.
    expect(canon([...rows].reverse(), true)).not.toBe(canon(rows, true));
  });
});
