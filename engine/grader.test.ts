import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ClozeExercise,
  CodeExercise,
  CodeLikeExercise,
  HarnessExercise,
  PredictExercise,
} from "../bank/schema.js";
import {
  grade,
  gradeCloze,
  gradePrediction,
  normalizeClozeAnswer,
  normalizeOutput,
  solutionFileName,
  WHITESPACE_PARTIAL_CREDIT,
} from "./grader.js";
import { JAVA_COMPILE_TIMEOUT_MS, hasJdk } from "./javatool.js";

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "atrophy-test-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const pyEx: CodeExercise = {
  id: "sr-py-901",
  kind: "write",
  axis: "syntax-recall",
  language: "python",
  tier: 1,
  title: "double",
  prompt: "double it",
  functionName: "double",
  starterCode: "def double(x):\n    pass\n",
  softTimeLimitSeconds: 300,
  testTimeoutMs: 15_000,
  tests: [
    { args: [2], expected: 4 },
    { args: [-1], expected: -2 },
    { args: [0], expected: 0 },
  ],
};

const jsEx: CodeExercise = {
  ...pyEx,
  id: "sr-js-901",
  language: "javascript",
  starterCode: "function double(x) {}\nmodule.exports = { double };\n",
};

function writeSolution(dir: string, ex: CodeLikeExercise, code: string): void {
  writeFileSync(join(dir, solutionFileName(ex)), code, "utf8");
}

describe("grade - python", () => {
  it("passes a correct solution", async () => {
    const dir = scratch();
    writeSolution(dir, pyEx, "def double(x):\n    return x * 2\n");
    const r = await grade(pyEx, dir);
    expect(r.harnessError).toBeUndefined();
    expect(r.passed).toBe(3);
    expect(r.total).toBe(3);
  });

  it("reports per-test failures with expected vs actual", async () => {
    const dir = scratch();
    writeSolution(dir, pyEx, "def double(x):\n    return x + 2\n");
    const r = await grade(pyEx, dir);
    expect(r.passed).toBe(1); // only x=2 works
    expect(r.failures.length).toBe(2);
    expect(r.failures[0]?.expected).toBe(-2);
    expect(r.failures[0]?.actual).toBe(1);
  });

  it("surfaces syntax errors as a load failure, not a crash", async () => {
    const dir = scratch();
    writeSolution(dir, pyEx, "def double(x)\n    return x\n");
    const r = await grade(pyEx, dir);
    expect(r.passed).toBe(0);
    expect(r.failures[0]?.index).toBe(-1);
    expect(r.failures[0]?.error).toMatch(/SyntaxError/);
  });

  it("kills infinite loops via the hard timeout", async () => {
    const dir = scratch();
    writeSolution(dir, pyEx, "def double(x):\n    while True:\n        pass\n");
    const fast = { ...pyEx, testTimeoutMs: 3000 };
    const r = await grade(fast, dir);
    expect(r.passed).toBe(0);
    expect(r.harnessError).toMatch(/timed out/);
  }, 20_000);
});

describe("grade - javascript", () => {
  it("passes a correct solution", async () => {
    const dir = scratch();
    writeSolution(dir, jsEx, "function double(x) { return x * 2; }\nmodule.exports = { double };\n");
    const r = await grade(jsEx, dir);
    expect(r.harnessError).toBeUndefined();
    expect(r.passed).toBe(3);
  });

  it("fails helpfully when the export is missing", async () => {
    const dir = scratch();
    writeSolution(dir, jsEx, "function double(x) { return x * 2; }\n");
    const r = await grade(jsEx, dir);
    expect(r.passed).toBe(0);
    expect(r.failures[0]?.error).toMatch(/not exported/);
  });

  it("compares objects with key order insensitivity", async () => {
    const dir = scratch();
    const ex: CodeExercise = {
      ...jsEx,
      id: "sr-js-902",
      functionName: "make",
      tests: [{ args: [], expected: { a: 1, b: 2 } }],
      starterCode: "x",
    };
    writeSolution(dir, ex, "function make() { return { b: 2, a: 1 }; }\nmodule.exports = { make };\n");
    const r = await grade(ex, dir);
    expect(r.passed).toBe(1);
  });
});

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
    expect(r.failures[0]?.error).toMatch(/no method named `twice`/);
  }, 60_000);

  it("kills infinite loops via the hard timeout", async () => {
    const dir = scratch();
    writeSolution(dir, javaEx, "public class Solution {\n    static int twice(int x) { while (true) {} }\n}\n");
    const fast = { ...javaEx, testTimeoutMs: 5000 };
    const r = await grade(fast, dir);
    expect(r.passed).toBe(0);
    expect(r.harnessError).toMatch(/timed out/);
    // The budget must cover compile (its own timeout) plus the timed-out run.
  }, JAVA_COMPILE_TIMEOUT_MS + 60_000);
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

  it("survives a harness that prints an unparseable marker line", async () => {
    const dir = scratch();
    const garbage: HarnessExercise = {
      ...harnessEx,
      id: "conc-java-904",
      testCode: 'public class Harness { public static void main(String[] a) { System.out.println("ATROPHY_RESULT {oops"); } }',
    };
    writeSolution(dir, garbage, garbage.starterCode);
    const r = await grade(garbage, dir);
    expect(r.harnessError).toMatch(/unparseable ATROPHY_RESULT/);
    expect(r.passed).toBe(0);
    expect(r.total).toBe(2);
  }, 90_000);

  it("survives a marker line that is valid JSON but not an object", async () => {
    const dir = scratch();
    const nullMarker: HarnessExercise = {
      ...harnessEx,
      id: "conc-java-905",
      testCode: 'public class Harness { public static void main(String[] a) { System.out.println("ATROPHY_RESULT null"); } }',
    };
    writeSolution(dir, nullMarker, nullMarker.starterCode);
    const r = await grade(nullMarker, dir);
    expect(r.harnessError).toMatch(/unparseable ATROPHY_RESULT/);
    expect(r.passed).toBe(0);
  }, 90_000);

  it("clamps a lying passed count to the declared total", async () => {
    const dir = scratch();
    const lying: HarnessExercise = {
      ...harnessEx,
      id: "conc-java-906",
      testCode: 'public class Harness { public static void main(String[] a) { System.out.println("ATROPHY_RESULT {\\"passed\\":7,\\"total\\":2,\\"failures\\":[]}"); } }',
    };
    writeSolution(dir, lying, lying.starterCode);
    const r = await grade(lying, dir);
    expect(r.harnessError).toBeUndefined();
    expect(r.passed).toBe(2);
    expect(r.total).toBe(2);
  }, 90_000);

  it("drops non-object entries from a marker's failures list", async () => {
    const dir = scratch();
    const nullEntry: HarnessExercise = {
      ...harnessEx,
      id: "conc-java-907",
      testCode: 'public class Harness { public static void main(String[] a) { System.out.println("ATROPHY_RESULT {\\"passed\\":0,\\"total\\":2,\\"failures\\":[null,{\\"index\\":0,\\"error\\":\\"real check\\"}]}"); } }',
    };
    writeSolution(dir, nullEntry, nullEntry.starterCode);
    const r = await grade(nullEntry, dir);
    expect(r.harnessError).toBeUndefined();
    expect(r.passed).toBe(0);
    // A null element here reaches printFailures, which reads f.args off it and throws
    // out of the drill loop - the good entry must survive, the junk must not.
    expect(r.failures).toEqual([{ index: 0, error: "real check" }]);
  }, 90_000);

  it("scores a marker with a non-finite passed as 0 rather than NaN", async () => {
    const dir = scratch();
    const noPassed: HarnessExercise = {
      ...harnessEx,
      id: "conc-java-908",
      testCode: 'public class Harness { public static void main(String[] a) { System.out.println("ATROPHY_RESULT {\\"total\\":2,\\"failures\\":[]}"); } }',
    };
    writeSolution(dir, noPassed, noPassed.starterCode);
    const r = await grade(noPassed, dir);
    expect(r.harnessError).toBeUndefined();
    expect(r.passed).toBe(0);
    expect(Number.isFinite(r.passed)).toBe(true); // NaN would ride into exerciseScore and the rating
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

// Deliberately outside the JDK gate: both paths fail before javac is ever spawned,
// so a host with no JDK still exercises part of the java grader.
describe("grade - java failure paths that need no JDK", () => {
  it("returns the install hint when the JDK is missing", async () => {
    const previous = process.env.ATROPHY_JAVA_HOME;
    process.env.ATROPHY_JAVA_HOME = join(tmpdir(), "atrophy-no-such-jdk-home");
    try {
      const r = await grade(javaEx, scratch());
      expect(r.passed).toBe(0);
      expect(r.total).toBe(3);
      expect(r.harnessError).toMatch(/not found - Java drills need a JDK/);
    } finally {
      if (previous === undefined) delete process.env.ATROPHY_JAVA_HOME;
      else process.env.ATROPHY_JAVA_HOME = previous;
    }
  });

  it("reports a staging failure instead of throwing into the drill loop", async () => {
    // An unusable grading dir makes the harness copy throw, the same branch a broken
    // install hits. Session.ts has no try/catch around grade(), so an escaping error
    // would end the session and lose the user's work - it must come back as a result.
    const r = await grade(javaEx, join(scratch(), "never-created"));
    expect(r.passed).toBe(0);
    expect(r.total).toBe(3);
    expect(r.harnessError).toMatch(/could not stage the Java harness/);
  });

  it("reports a staging failure for testCode exercises too", async () => {
    // Same invariant on the harness path: writing Harness.java / copying Atrophy.java
    // must not throw out of grade() and take the drill session down with it.
    const r = await grade(harnessEx, join(scratch(), "never-created"));
    expect(r.passed).toBe(0);
    expect(r.total).toBe(harnessEx.totalChecks);
    expect(r.harnessError).toMatch(/could not stage the Java harness/);
  });
});

describe("normalizeOutput", () => {
  it("ignores CRLF, trailing spaces, and outer blank lines", () => {
    expect(normalizeOutput("a \r\nb\r\n\r\n")).toBe("a\nb");
    expect(normalizeOutput("\n\na\nb")).toBe("a\nb");
  });
  it("keeps inner blank lines and case", () => {
    expect(normalizeOutput("a\n\nB")).toBe("a\n\nB");
  });
});

const predictPy: PredictExercise = {
  id: "cr-py-901",
  kind: "predict-output",
  axis: "code-reading",
  language: "python",
  tier: 1,
  title: "aliasing",
  prompt: "what does this print?",
  softTimeLimitSeconds: 120,
  testTimeoutMs: 15_000,
  snippet: 'a = [1, 2]\nb = a\nb.append(3)\nprint(len(a))\nprint(a is b)\n',
};

describe("gradePrediction", () => {
  it("accepts a correct prediction (python ground truth)", async () => {
    const r = await gradePrediction(predictPy, scratch(), "3\nTrue\n");
    expect(r.error).toBeUndefined();
    expect(r.correct).toBe(true);
    expect(r.actual).toBe("3\nTrue");
  });

  it("rejects a wrong prediction and returns the real output", async () => {
    const r = await gradePrediction(predictPy, scratch(), "2\nFalse");
    expect(r.correct).toBe(false);
    expect(r.actual).toBe("3\nTrue");
  });

  it("runs javascript snippets via node", async () => {
    const ex: PredictExercise = {
      ...predictPy,
      id: "cr-js-901",
      language: "javascript",
      snippet: 'console.log(1 + "2");\nconsole.log(typeof null);\n',
    };
    const r = await gradePrediction(ex, scratch(), "12\nobject");
    expect(r.correct).toBe(true);
  });

  it("flags a broken snippet as a bank error, not a user failure", async () => {
    const ex: PredictExercise = { ...predictPy, id: "cr-py-902", snippet: "print(undefined_name)\n" };
    const r = await gradePrediction(ex, scratch(), "anything");
    expect(r.correct).toBe(false);
    expect(r.error).toMatch(/snippet failed/);
  });

  it("exact match earns full credit", async () => {
    const r = await gradePrediction(predictPy, scratch(), "3\nTrue\n");
    expect(r.correct).toBe(true);
    expect(r.credit).toBe(1);
    expect(r.whitespaceOnly).toBe(false);
  });

  it("gives partial credit for a whitespace-only miss (the [5,4,79] case)", async () => {
    const ex: PredictExercise = { ...predictPy, id: "cr-py-903", snippet: "print([5, 4, 79])\n" };
    const r = await gradePrediction(ex, scratch(), "[5,4,79]");
    expect(r.correct).toBe(false);
    expect(r.whitespaceOnly).toBe(true);
    expect(r.credit).toBe(WHITESPACE_PARTIAL_CREDIT);
    expect(r.actual).toBe("[5, 4, 79]");
  });

  it("a real content mismatch earns zero, not partial", async () => {
    const r = await gradePrediction(predictPy, scratch(), "2\nFalse");
    expect(r.credit).toBe(0);
    expect(r.whitespaceOnly).toBe(false);
  });
});

const clozeEx: ClozeExercise = {
  id: "api-py-901",
  kind: "cloze",
  axis: "api-memory",
  language: "python",
  tier: 1,
  title: "sort by length",
  prompt: "fill the blank",
  softTimeLimitSeconds: 60,
  testTimeoutMs: 10_000,
  snippet: "sorted(words, key=____)",
  acceptedAnswers: ["len"],
};

describe("gradeCloze", () => {
  it("matches accepted answers, whitespace-insensitively", () => {
    expect(gradeCloze(clozeEx, "len")).toBe(true);
    expect(gradeCloze(clozeEx, "  len ")).toBe(true);
    expect(gradeCloze(clozeEx, "size")).toBe(false);
  });
  it("stays case-sensitive (API names are)", () => {
    expect(gradeCloze(clozeEx, "LEN")).toBe(false);
  });
  it("collapses internal whitespace runs", () => {
    expect(normalizeClozeAnswer("lambda  w:  len(w)")).toBe("lambda w: len(w)");
  });
});
