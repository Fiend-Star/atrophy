import { describe, expect, it } from "vitest";
import { acceptedForBlank, blankResults, countBlanks, gradeCloze, promptCount } from "./cloze.js";
import { exerciseSchema, totalUnits, type ClozeExercise } from "../bank/schema.js";

/** Parse the way the bank does, then narrow - `Exercise` is a union with no `snippet`. */
const mk = (snippet: string, acceptedAnswers: string[] | string[][]): ClozeExercise => {
  const ex = exerciseSchema.parse({ id: "api-x-901", axis: "api-memory", tier: 1, title: "t", prompt: "p", softTimeLimitSeconds: 60, kind: "cloze", language: "java", snippet, acceptedAnswers });
  if (ex.kind !== "cloze") throw new Error(`expected a cloze, got ${ex.kind}`);
  return ex;
};

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

describe("flat answers on a multi-blank snippet", () => {
  // The shape api-py-003/004 and three api-py-gen facts already ship: "the same stdlib
  // module goes in both blanks" - one accepted set, N blanks, one answer typed once.
  const shared = mk('import ____\n\nconfig = ____.load(f)', ["json"]);

  it("grades every blank as a unit but asks only once", () => {
    expect(countBlanks(shared.snippet)).toBe(2);
    expect(promptCount(shared)).toBe(1);
    expect(totalUnits(shared)).toBe(2);
  });

  it("credits every blank from the single answer, all or nothing", () => {
    expect(gradeCloze(shared, ["json"])).toEqual({ blanksCorrect: 2, totalBlanks: 2 });
    expect(gradeCloze(shared, ["pickle"])).toEqual({ blanksCorrect: 0, totalBlanks: 2 });
    expect(acceptedForBlank(shared, 1)).toEqual(["json"]);
  });
});

describe("per-blank answers", () => {
  const ex = mk("a.____(x); b.____(y)", [["add"], ["remove"]]);

  it("asks once per blank and counts one unit per blank", () => {
    expect(promptCount(ex)).toBe(2);
    expect(totalUnits(ex)).toBe(2);
  });

  it("reports which blanks were right, in blank order", () => {
    expect(blankResults(ex, ["add", "remove"])).toEqual([true, true]);
    expect(blankResults(ex, ["nope", "remove"])).toEqual([false, true]);
  });

  it("treats a missing or empty answer as unfilled, never as a match", () => {
    expect(gradeCloze(ex, [])).toEqual({ blanksCorrect: 0, totalBlanks: 2 });
    expect(gradeCloze(ex, ["add"])).toEqual({ blanksCorrect: 1, totalBlanks: 2 });
    expect(gradeCloze(ex, ["add", "   "])).toEqual({ blanksCorrect: 1, totalBlanks: 2 });
  });

  it("has no accepted set past the last blank", () => {
    expect(acceptedForBlank(ex, 2)).toEqual([]);
  });
});

describe("answer normalization", () => {
  const ex = mk("sorted(words, key=____)", ["len"]);

  it("matches accepted answers, whitespace-insensitively", () => {
    expect(gradeCloze(ex, ["len"]).blanksCorrect).toBe(1);
    expect(gradeCloze(ex, ["  len "]).blanksCorrect).toBe(1);
    expect(gradeCloze(ex, ["size"]).blanksCorrect).toBe(0);
  });

  it("stays case-sensitive (API names are)", () => {
    expect(gradeCloze(ex, ["LEN"]).blanksCorrect).toBe(0);
  });

  it("collapses internal whitespace runs on both sides", () => {
    const lambda = mk("sorted(words, key=____)", ["lambda w: len(w)"]);
    expect(gradeCloze(lambda, ["lambda  w:  len(w)"]).blanksCorrect).toBe(1);
  });
});

describe("schema rules for the cloze shape", () => {
  const parse = (snippet: string, acceptedAnswers: unknown) =>
    exerciseSchema.safeParse({ id: "api-x-902", axis: "api-memory", tier: 1, title: "t", prompt: "p", softTimeLimitSeconds: 60, kind: "cloze", language: "java", snippet, acceptedAnswers });

  /** A rejection proves a rule only if the rule is the single thing wrong with the fixture. */
  const soleIssue = (snippet: string, acceptedAnswers: unknown): string => {
    const result = parse(snippet, acceptedAnswers);
    expect(result.success).toBe(false);
    const issues = result.success ? [] : result.error.issues;
    expect(issues).toHaveLength(1);
    return issues[0]?.message ?? "";
  };

  it("rejects more accepted sets than blanks, and nothing else", () => {
    expect(soleIssue("only one ____", [["a"], ["b"]])).toMatch(/one set per ____ blank \(sets: 2, blanks: 1\)/);
  });

  it("rejects fewer accepted sets than blanks, and nothing else", () => {
    expect(soleIssue("____ and ____", [["a"]])).toMatch(/one set per ____ blank \(sets: 1, blanks: 2\)/);
  });

  it("rejects a snippet with no blank at all, and nothing else", () => {
    expect(soleIssue("no blank here", ["a"])).toMatch(/at least one ____ blank/);
  });

  it("rejects a mixed array outright (neither shape)", () => {
    expect(parse("____ ____", ["a", ["b"]]).success).toBe(false);
  });

  it("accepts the flat shape whatever the blank count", () => {
    expect(parse("____", ["a"]).success).toBe(true);
    expect(parse("____ ____", ["a"]).success).toBe(true);
    expect(parse("____ ____", [["a"], ["b"]]).success).toBe(true);
  });
});
