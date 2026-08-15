import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BankError, exerciseSchema, isHarness, isSqlWrite, JVM_KINDS, loadBank, parseExercise, totalUnits, type CodeExercise, type HarnessExercise, type RecallExercise } from "./schema.js";

const here = fileURLToPath(new URL(".", import.meta.url));

const valid = {
  id: "sr-py-001",
  kind: "write",
  axis: "syntax-recall",
  language: "python",
  tier: 1,
  title: "t",
  prompt: "p",
  functionName: "f",
  starterCode: "def f(): pass",
  softTimeLimitSeconds: 300,
  tests: [{ args: [1], expected: 2 }],
};

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

describe("parseExercise", () => {
  it("accepts a valid write exercise and applies defaults", () => {
    const ex = parseExercise(JSON.stringify(valid));
    expect(ex.id).toBe("sr-py-001");
    expect(ex.testTimeoutMs).toBe(10_000); // default
  });

  it("accepts the other kinds", () => {
    expect(parseExercise(JSON.stringify({ ...valid, id: "dbg-py-001", kind: "fix", axis: "debugging" })).kind).toBe("fix");
    const predict = { id: "cr-py-001", kind: "predict-output", axis: "code-reading", language: "python", tier: 1, title: "t", prompt: "p", softTimeLimitSeconds: 120, snippet: "print(1)" };
    expect(parseExercise(JSON.stringify(predict)).kind).toBe("predict-output");
    const cloze = { id: "api-py-001", kind: "cloze", axis: "api-memory", language: "python", tier: 1, title: "t", prompt: "p", softTimeLimitSeconds: 60, snippet: "x = ____(y)", acceptedAnswers: ["len"] };
    expect(parseExercise(JSON.stringify(cloze)).kind).toBe("cloze");
    const outline = { id: "dec-any-001", kind: "outline", axis: "decomposition", language: "any", tier: 1, title: "t", prompt: "p", softTimeLimitSeconds: 420, rubric: ["a", "b"] };
    expect(parseExercise(JSON.stringify(outline)).kind).toBe("outline");
  });

  it("rejects malformed JSON with the source name", () => {
    expect(() => parseExercise("{nope", "bank/x.json")).toThrowError(/bank\/x\.json.*invalid JSON/s);
  });

  it.each([
    ["bad id", { ...valid, id: "WeirdId!" }],
    ["unknown kind", { ...valid, kind: "vibes" }],
    ["missing kind", { ...valid, kind: undefined }],
    ["unknown axis", { ...valid, axis: "vibes" }],
    ["unknown language", { ...valid, language: "rust" }],
    ["tier out of range", { ...valid, tier: 4 }],
    ["empty tests", { ...valid, tests: [] }],
    ["missing prompt", { ...valid, prompt: undefined }],
    ["cloze without acceptedAnswers", { id: "api-py-002", kind: "cloze", axis: "api-memory", language: "python", tier: 1, title: "t", prompt: "p", softTimeLimitSeconds: 60, snippet: "____" }],
    ["outline with a concrete language", { id: "dec-any-002", kind: "outline", axis: "decomposition", language: "python", tier: 1, title: "t", prompt: "p", softTimeLimitSeconds: 420, rubric: ["a"] }],
    ["predict-output without snippet", { id: "cr-py-002", kind: "predict-output", axis: "code-reading", language: "python", tier: 1, title: "t", prompt: "p", softTimeLimitSeconds: 120 }],
  ])("rejects %s", (_name, bad) => {
    expect(() => parseExercise(JSON.stringify(bad))).toThrow(BankError);
  });

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
});

describe("totalUnits", () => {
  it("counts tests, single answers, and rubric points", () => {
    expect(totalUnits(parseExercise(JSON.stringify(valid)))).toBe(1);
    const outline = { id: "dec-any-001", kind: "outline", axis: "decomposition", language: "any", tier: 1, title: "t", prompt: "p", softTimeLimitSeconds: 420, rubric: ["a", "b", "c"] };
    expect(totalUnits(parseExercise(JSON.stringify(outline)))).toBe(3);
    const cloze = { id: "api-py-001", kind: "cloze", axis: "api-memory", language: "python", tier: 1, title: "t", prompt: "p", softTimeLimitSeconds: 60, snippet: "____", acceptedAnswers: ["len"] };
    expect(totalUnits(parseExercise(JSON.stringify(cloze)))).toBe(1);
  });

  it("counts a cloze's blanks under either accepted-answer shape", () => {
    const perBlank = { id: "api-py-002", kind: "cloze", axis: "api-memory", language: "python", tier: 1, title: "t", prompt: "p", softTimeLimitSeconds: 60, snippet: "a.____(x); b.____(y)", acceptedAnswers: [["add"], ["remove"]] };
    expect(totalUnits(parseExercise(JSON.stringify(perBlank)))).toBe(2);
    // The flat shape means "the same answer fills every blank" (api-py-003 ships it):
    // still one graded unit per blank, but a single typed answer earns them all.
    const shared = { ...perBlank, id: "api-py-003", acceptedAnswers: ["add"] };
    expect(totalUnits(parseExercise(JSON.stringify(shared)))).toBe(2);
  });
});

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
    const parsed = parseExercise(JSON.stringify(recall)) as RecallExercise;
    expect(parsed.kind).toBe("recall");
    // z.object strips unknown keys, so this is what proves reveal is in the schema at all.
    expect(parsed.reveal).toBe("P(no collision) drops below 0.5 at n=23.");
    const { reveal: _reveal, ...noReveal } = recall;
    const parsedNoReveal = parseExercise(JSON.stringify(noReveal)) as RecallExercise;
    expect(parsedNoReveal.kind).toBe("recall");
    expect(parsedNoReveal.reveal).toBeUndefined();
  });
  it("counts one unit and rejects empty answers and blank strings", () => {
    expect(totalUnits(parseExercise(JSON.stringify(recall)))).toBe(1);
    expect(() => parseExercise(JSON.stringify({ ...recall, acceptedAnswers: [] }))).toThrow(BankError);
    expect(() => parseExercise(JSON.stringify({ ...recall, acceptedAnswers: [""] }))).toThrow(BankError);
    expect(() => parseExercise(JSON.stringify({ ...recall, reveal: "" }))).toThrow(BankError);
  });
  it("takes a concrete language as well as \"any\", and still nothing else", () => {
    // A drill about JVM flags or SQL window functions is not language-agnostic just
    // because answering it runs no toolchain; "any" stays the tag for the ones that are.
    for (const language of ["java", "sql", "python", "javascript", "any"]) {
      const parsed = parseExercise(JSON.stringify({ ...recall, language })) as RecallExercise;
      expect(parsed.language).toBe(language);
    }
    expect(() => parseExercise(JSON.stringify({ ...recall, language: "rust" }))).toThrow(BankError);
    expect(() => parseExercise(JSON.stringify({ ...recall, language: undefined }))).toThrow(BankError);
  });
});

describe("harness kinds", () => {
  it("accepts both harness kinds and counts totalChecks units", () => {
    const ex = parseExercise(JSON.stringify(harness));
    expect(ex.kind).toBe("write-harness");
    expect(totalUnits(ex)).toBe(3);
    expect(parseExercise(JSON.stringify({ ...harness, id: "conc-java-002", kind: "fix-harness" })).kind).toBe("fix-harness");
  });
  it("carries starterCode and testCode through parsing", () => {
    // z.object strips unknown keys, so this is what proves the harness fields are in the schema at all.
    const parsed = parseExercise(JSON.stringify(harness)) as HarnessExercise;
    expect(parsed.starterCode).toBe(harness.starterCode);
    expect(parsed.testCode).toBe(harness.testCode);
  });
  it("narrows harness kinds only", () => {
    expect(isHarness(parseExercise(JSON.stringify(harness)))).toBe(true);
    expect(isHarness(parseExercise(JSON.stringify({ ...harness, id: "conc-java-002", kind: "fix-harness" })))).toBe(true);
    expect(isHarness(parseExercise(JSON.stringify(valid)))).toBe(false);
  });
  it.each([
    ["non-java language", { ...harness, language: "python" }],
    ["missing testCode", { ...harness, testCode: undefined }],
    ["empty testCode", { ...harness, testCode: "" }],
    ["empty starterCode", { ...harness, starterCode: "" }],
    ["zero totalChecks", { ...harness, totalChecks: 0 }],
    ["fractional totalChecks", { ...harness, totalChecks: 1.5 }],
  ])("rejects %s", (_name, bad) => {
    expect(() => parseExercise(JSON.stringify(bad))).toThrow(BankError);
  });
});

describe("submitPolicy", () => {
  it("accepts single on write and harness kinds; rejects junk", () => {
    // z.object strips unknown keys, so reading the value back is what proves submitPolicy is in the schema at all.
    expect((parseExercise(JSON.stringify({ ...valid, submitPolicy: "single" })) as CodeExercise).submitPolicy).toBe("single");
    expect((parseExercise(JSON.stringify(valid)) as CodeExercise).submitPolicy).toBeUndefined();
    expect(() => parseExercise(JSON.stringify({ ...valid, submitPolicy: "yolo" }))).toThrow(BankError);
    expect(() => parseExercise(JSON.stringify({ ...valid, submitPolicy: "yolo" }))).toThrow(/submitPolicy/);
  });

  it("round-trips on harness kinds too", () => {
    const single = parseExercise(JSON.stringify({ ...harness, submitPolicy: "single" })) as HarnessExercise;
    expect(single.submitPolicy).toBe("single");
    const loop = parseExercise(JSON.stringify({ ...harness, submitPolicy: "loop" })) as HarnessExercise;
    expect(loop.submitPolicy).toBe("loop");
    expect((parseExercise(JSON.stringify(harness)) as HarnessExercise).submitPolicy).toBeUndefined();
    expect(() => parseExercise(JSON.stringify({ ...harness, submitPolicy: "yolo" }))).toThrow(/submitPolicy/);
  });
});

const base = {
  id: "sr-sql-901", axis: "syntax-recall", tier: 1, title: "t", prompt: "p",
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
  it("accepts ordered on a sql write, and rejects it off sql in either state", () => {
    const ex = exerciseSchema.parse({ ...base, kind: "write", language: "sql", starterCode: "-- q", cases: sqlCases, ordered: true });
    expect(isSqlWrite(ex) && ex.ordered).toBe(true);
    // The refinement tests `ordered !== undefined`, not truthiness, and that is
    // load-bearing: `ordered: false` off sql is still a sql-only field being set on a
    // python exercise, and a truthiness refactor would silently start accepting it.
    const pyWith = (ordered: boolean) => () =>
      exerciseSchema.parse({ ...base, kind: "write", language: "python", functionName: "f", starterCode: "def f(): pass", tests: [{ args: [], expected: 1 }], ordered });
    expect(pyWith(true)).toThrow(/ordered is sql-only/);
    expect(pyWith(false)).toThrow(/ordered is sql-only/);
  });
  it("rejects sql on fix and predict-output", () => {
    // Pinned to the rule's own message: the fix fixture is invalid four ways over
    // (sql language, missing tests, missing functionName, sql-only cases), so a bare
    // .toThrow() would stay green with the sql-on-fix rule deleted.
    expect(() => exerciseSchema.parse({ ...base, kind: "fix", language: "sql", starterCode: "-- q", cases: sqlCases })).toThrow(/sql is write-only/);
    expect(() => exerciseSchema.parse({ ...base, kind: "predict-output", language: "sql", snippet: "SELECT 1;" })).toThrow(/sql is write-only/);
  });
  it("accepts sql on cloze, which the rejection message above promises", () => {
    // That message tells the author "a sql cloze or recall is fine". The recall half is
    // pinned by the recall suite's language loop; this is the cloze half, so the string
    // cannot quietly become a lie if a future rule starts rejecting sql clozes. Nothing
    // runs for either kind - both grade by matching what the user typed.
    const ex = exerciseSchema.parse({
      ...base, id: "api-sql-901", axis: "api-memory", kind: "cloze", language: "sql",
      snippet: "SELECT ____(*) FROM t;", acceptedAnswers: ["COUNT"],
    });
    expect(ex.language).toBe("sql");
  });
  it("exports JVM_KINDS as the four java-graded kinds", () => {
    expect([...JVM_KINDS]).toEqual(["write", "fix", "write-harness", "fix-harness"]);
  });
});

describe("loadBank", () => {
  it("loads every shipped seed exercise (bank stays valid)", () => {
    const bank = loadBank(join(here, "exercises"));
    expect(bank.length).toBeGreaterThanOrEqual(6);
    const ids = bank.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("loadBank multi-dir", () => {
  /** Keys may contain a subdirectory ("nested/deep.json"); parent dirs are created. */
  function tempBank(files: Record<string, object>): string {
    const dir = mkdtempSync(join(tmpdir(), "atrophy-bank-"));
    for (const [name, ex] of Object.entries(files)) {
      const full = join(dir, name);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, JSON.stringify(ex), "utf8");
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
  it("tolerates the same root listed twice, loading each exercise once", () => {
    const a = tempBank({ "a.json": valid, "b.json": { ...valid, id: "sr-py-002" } });
    try {
      expect(loadBank([a, a]).map((e) => e.id).sort()).toEqual(["sr-py-001", "sr-py-002"]);
    } finally {
      rmSync(a, { recursive: true, force: true });
    }
  });
  it("tolerates a root nested inside another root", () => {
    const a = tempBank({ "a.json": valid, "packs/b.json": { ...valid, id: "sr-py-002" } });
    try {
      expect(loadBank([a, join(a, "packs")]).map((e) => e.id).sort()).toEqual(["sr-py-001", "sr-py-002"]);
    } finally {
      rmSync(a, { recursive: true, force: true });
    }
  });
  it("still fails on two files with the same id inside one directory, naming both", () => {
    const a = tempBank({ "dup-a.json": valid, "dup-b.json": valid });
    try {
      // Order-independent: which file readdirSync yields first is filesystem-dependent.
      expect(() => loadBank([a])).toThrowError(/duplicate exercise id: sr-py-001/);
      expect(() => loadBank([a])).toThrowError(/dup-a\.json/);
      expect(() => loadBank([a])).toThrowError(/dup-b\.json/);
    } finally {
      rmSync(a, { recursive: true, force: true });
    }
  });
  it("recurses into subdirectories of a root passed in the array form", () => {
    const a = tempBank({ "nested/deep.json": { ...valid, id: "sr-py-003" } });
    try {
      expect(loadBank([a]).map((e) => e.id)).toEqual(["sr-py-003"]);
    } finally {
      rmSync(a, { recursive: true, force: true });
    }
  });
});
