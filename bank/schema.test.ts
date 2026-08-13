import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BankError, isHarness, loadBank, parseExercise, totalUnits, type CodeExercise, type HarnessExercise, type RecallExercise } from "./schema.js";

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
  it("counts one unit and rejects concrete languages, empty answers, and blank strings", () => {
    expect(totalUnits(parseExercise(JSON.stringify(recall)))).toBe(1);
    expect(() => parseExercise(JSON.stringify({ ...recall, language: "java" }))).toThrow(BankError);
    expect(() => parseExercise(JSON.stringify({ ...recall, acceptedAnswers: [] }))).toThrow(BankError);
    expect(() => parseExercise(JSON.stringify({ ...recall, acceptedAnswers: [""] }))).toThrow(BankError);
    expect(() => parseExercise(JSON.stringify({ ...recall, reveal: "" }))).toThrow(BankError);
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

describe("loadBank", () => {
  it("loads every shipped seed exercise (bank stays valid)", () => {
    const bank = loadBank(join(here, "exercises"));
    expect(bank.length).toBeGreaterThanOrEqual(6);
    const ids = bank.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
