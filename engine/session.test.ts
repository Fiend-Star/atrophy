import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ClozeExercise,
  CodeExercise,
  CodeLikeExercise,
  Exercise,
  HarnessExercise,
  PredictExercise,
  RecallExercise,
  SqlWriteExercise,
} from "../bank/schema.js";
import { hasJdk } from "./javatool.js";
import { commentPrefix, previewExercise, runDrill, type DrillOutcome } from "./session.js";

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "atrophy-session-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Write a pre-baked answer file for the `--solution` (non-interactive) path. */
function solutionFile(code: string): string {
  const file = join(scratch(), "answer.txt");
  writeFileSync(file, code, "utf8");
  return file;
}

function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return { lines, restore: () => spy.mockRestore() };
}

/**
 * Drive an interactive drill without a terminal: swap process.stdin for a stream and
 * feed the next answer whenever readline prints a prompt (the "[Enter] …" line). Waiting
 * on the prompt rather than a timer keeps it deterministic - an answer written while the
 * grader is running would be read as a line with no question pending and silently lost.
 *
 * `promptMatch` is the substring that identifies a prompt; kinds that ask a plain
 * question (recall, cloze) never print "[Enter]", so they pass their own marker.
 */
async function driveDrill(
  ex: Exercise,
  answers: string[],
  promptMatch = "[Enter]",
): Promise<{ outcome: DrillOutcome; output: string; prompts: string }> {
  const fake = new PassThrough();
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin")!;
  Object.defineProperty(process, "stdin", { value: fake, configurable: true });
  const previousEditor = process.env.ATROPHY_EDITOR;
  process.env.ATROPHY_EDITOR = "echo"; // a no-op "editor" on both cmd and sh
  const { lines, restore: restoreLog } = captureLog();
  const queue = [...answers];
  // readline writes prompts here, not through console.log - assertions about which
  // prompt the user was offered ("fix & resubmit" vs not) have to read these chunks.
  const prompts: string[] = [];
  const writeSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(((chunk: unknown) => {
      if (typeof chunk === "string") {
        prompts.push(chunk);
        if (chunk.includes(promptMatch)) {
          const next = queue.shift();
          if (next !== undefined) setImmediate(() => fake.write(`${next}\n`));
        }
      }
      return true;
    }) as typeof process.stdout.write);
  try {
    const outcome = await runDrill(ex);
    return { outcome, output: lines.join("\n"), prompts: prompts.join("\n") };
  } finally {
    writeSpy.mockRestore();
    restoreLog();
    Object.defineProperty(process, "stdin", stdinDescriptor);
    if (previousEditor === undefined) delete process.env.ATROPHY_EDITOR;
    else process.env.ATROPHY_EDITOR = previousEditor;
    fake.end();
  }
}

const pyEx: CodeExercise = {
  id: "sr-py-950",
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
  tests: [{ args: [2], expected: 4 }],
};

const harnessEx: HarnessExercise = {
  id: "conc-java-950",
  kind: "write-harness",
  axis: "syntax-recall",
  language: "java",
  tier: 3,
  title: "counter",
  prompt: "Make Counter.increment() thread-safe.",
  softTimeLimitSeconds: 600,
  testTimeoutMs: 30_000,
  totalChecks: 1,
  starterCode: "public class Solution {\n    private int n = 0;\n    public void increment() { n++; }\n    public int value() { return n; }\n}\n",
  // Deliberately deterministic (no race): this fixture is about session plumbing,
  // and grader.test.ts already owns the concurrency behaviour.
  testCode: `public class Harness {
    public static void main(String[] args) throws Exception {
        Atrophy.plan(1);
        Solution s = new Solution();
        s.increment();
        Atrophy.check("increment() advances value()", s.value() == 1);
        Atrophy.report();
    }
}`,
};

describe("previewExercise", () => {
  it("shows starter code for harness kinds (they are edit-a-solution drills too)", () => {
    const { lines, restore } = captureLog();
    try {
      previewExercise(harnessEx);
    } finally {
      restore();
    }
    const output = lines.join("\n");
    expect(output).toContain("starter code:");
    expect(output).toContain("public void increment()");
  });
});

describe("runDrill - whiteboard mode (submitPolicy: single)", () => {
  it("grades exactly once and says so instead of offering a retry", async () => {
    // Two answers: the first Enter trips the "file hasn't changed" guard (not a
    // submission), the second is the one graded submission.
    const { outcome, output, prompts } = await driveDrill({ ...pyEx, submitPolicy: "single" }, ["", ""]);
    expect(outcome.abandoned).toBe(false);
    expect(outcome.passed).toBe(0);
    expect(outcome.total).toBe(1);
    expect(output).toContain("whiteboard mode: single submission, no retries");
    expect(prompts).not.toContain("fix & resubmit"); // the retry prompt was never offered
  }, 30_000);

  it("does not consume the single submission when the toolchain fails", async () => {
    // A harnessError is not drill evidence: a missing JDK (or any grading failure)
    // must leave the one submission intact rather than scoring the user 0.
    const previous = process.env.ATROPHY_JAVA_HOME;
    process.env.ATROPHY_JAVA_HOME = join(tmpdir(), "atrophy-no-such-jdk-home");
    try {
      const { outcome, output, prompts } = await driveDrill(
        { ...harnessEx, submitPolicy: "single" },
        ["", "", "q"],
      );
      expect(output).toContain("Your code did not run");
      expect(output).not.toContain("whiteboard mode");
      // Being asked to submit a third time is the proof the submission was not consumed
      // (two answers went in before the failed grade). It is the plain submit prompt, not
      // the retry one: a run that graded nothing leaves nothing to stop on either.
      expect(prompts.split("[Enter] submit").length - 1).toBeGreaterThanOrEqual(3);
      expect(prompts).not.toContain("stop here");
      expect(outcome.abandoned).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.ATROPHY_JAVA_HOME;
      else process.env.ATROPHY_JAVA_HOME = previous;
    }
  }, 30_000);

  it("still loops when no policy is set (absent means loop, not 'loop')", async () => {
    // Same two answers, then "q": reaching the third prompt at all proves the
    // submit loop survived a failed attempt.
    const { outcome, output } = await driveDrill(pyEx, ["", "", "q"]);
    expect(outcome.abandoned).toBe(true);
    expect(output).not.toContain("whiteboard mode");
    expect(output).toContain("1 tests passed");
  }, 30_000);
});

// Deliberately outside the JDK gate: the point is what happens when there is no JDK.
describe("runDrill - interactive when grading never ran", () => {
  it("treats a python timeout the same way - no score, no stop, no rating move", async () => {
    // A timeout arrives as a harnessError in every language (parseMarker turns a run
    // that printed no marker into one), so this rule is not java-only: an infinite loop
    // means the checks never ran, and "0/1 tests passed" would be a verdict on a drill
    // that produced no evidence. The user fixes the loop and submits again.
    const spinner: CodeExercise = {
      ...pyEx,
      id: "sr-py-951",
      title: "spin",
      functionName: "spin",
      starterCode: "def spin(n):\n    while True:\n        pass\n",
      testTimeoutMs: 3_000,
    };
    const { outcome, output, prompts } = await driveDrill(spinner, ["", "", "s", "q"]);
    expect(output).toContain("timed out");
    expect(output).not.toContain("tests passed");
    expect(prompts).not.toContain("stop here");
    expect(outcome.abandoned).toBe(true);
    expect(outcome.score).toBe(0);
  }, 30_000);

  it("offers no way to stop on a harnessError, so 's' cannot record a 0/n", async () => {
    // The rating-integrity leg of the same invariant the --solution test below pins.
    // "s" ends the drill at the last graded result, and drillOnce records that outcome -
    // so if a harnessError enabled it, a missing JDK would move the unaided rating.
    const previous = process.env.ATROPHY_JAVA_HOME;
    process.env.ATROPHY_JAVA_HOME = join(tmpdir(), "atrophy-no-such-jdk-home");
    try {
      // "" trips the unchanged-file guard, "" grades (and fails to run), then "s", then "q".
      const { outcome, output, prompts } = await driveDrill(harnessEx, ["", "", "s", "q"]);
      expect(prompts).not.toContain("stop here");
      expect(outcome.abandoned).toBe(true);
      expect(outcome.passed).toBe(0);
      expect(outcome.score).toBe(0);
      expect(output).toContain("Your code did not run");
      // Nor is a score reported for a run that produced no checks: "0/1 tests passed"
      // reads as a verdict on the user, and there was no verdict to give.
      expect(output).not.toContain("tests passed");
    } finally {
      if (previous === undefined) delete process.env.ATROPHY_JAVA_HOME;
      else process.env.ATROPHY_JAVA_HOME = previous;
    }
  }, 30_000);
});

describe("runDrill - --solution when grading never ran", () => {
  it("abandons instead of scoring a 0 the user did not earn", async () => {
    const previous = process.env.ATROPHY_JAVA_HOME;
    process.env.ATROPHY_JAVA_HOME = join(tmpdir(), "atrophy-no-such-jdk-home");
    const { lines, restore } = captureLog();
    let outcome: DrillOutcome;
    try {
      outcome = await runDrill(harnessEx, solutionFile(harnessEx.starterCode));
    } finally {
      restore();
      if (previous === undefined) delete process.env.ATROPHY_JAVA_HOME;
      else process.env.ATROPHY_JAVA_HOME = previous;
    }
    // Abandoned is what stops cli/index.ts recording the session at all: a missing
    // JDK is not evidence about the user, so the unaided rating must not move.
    expect(outcome.abandoned).toBe(true);
    expect(outcome.passed).toBe(0);
    expect(outcome.score).toBe(0);
    expect(lines.join("\n")).toContain("Your code did not run");
  }, 30_000);
});

describe("commentPrefix", () => {
  it("uses each language's own comment syntax", () => {
    // The header this builds is prepended to the file the grader hands straight to the
    // toolchain, so the wrong prefix fails the drill before the user's answer is read -
    // that is why sql got "--", and why shell rides python's "#": the "//" fallthrough
    // would put a comment bash reads as a path at the top of every script.
    const prefixed = (language: string) => commentPrefix({ ...pyEx, language } as CodeLikeExercise);
    expect(prefixed("python")).toBe("#");
    expect(prefixed("shell")).toBe("#");
    expect(prefixed("sql")).toBe("--");
    expect(prefixed("javascript")).toBe("//");
    expect(prefixed("java")).toBe("//");
  });
});

const sqlEx: SqlWriteExercise = {
  id: "sr-sql-950",
  kind: "write",
  axis: "syntax-recall",
  language: "sql",
  tier: 1,
  title: "sum per key",
  prompt: "One row per k, with SUM(v) AS s.",
  // Already the right answer: the only thing left that can fail is the file the
  // session builds around it.
  starterCode: "SELECT k, SUM(v) AS s FROM t GROUP BY k",
  softTimeLimitSeconds: 300,
  testTimeoutMs: 15_000,
  cases: [
    { fixture: "CREATE TABLE t(k TEXT, v INT); INSERT INTO t VALUES ('a',1),('a',2),('b',5);", expectedRows: [{ k: "a", s: 3 }, { k: "b", s: 5 }] },
    { fixture: "CREATE TABLE t(k TEXT, v INT); INSERT INTO t VALUES ('z',7);", expectedRows: [{ k: "z", s: 7 }] },
  ],
};

describe("runDrill - sql", () => {
  it("grades the solution file the session generates, header comment and all", async () => {
    // The header is not decoration: it is prepended to the file handed straight to
    // db.prepare(). A sql drill must not get the "//" prefix the other non-python languages
    // use: SQLite rejects it, and the drill would die on its own header before reading the
    // query.
    // Two answers: the first Enter trips the "file hasn't changed" guard, the second
    // submits the untouched starter.
    const { outcome, output } = await driveDrill(sqlEx, ["", ""]);
    expect(outcome.abandoned).toBe(false);
    expect(outcome.passed).toBe(2);
    expect(outcome.total).toBe(2);
    expect(output).toContain("2/2 tests passed");
  }, 30_000);

  it("abandons rather than scoring 0 when the exercise's own fixture is broken", async () => {
    const brokenFixture: SqlWriteExercise = {
      ...sqlEx,
      id: "sr-sql-951",
      cases: [
        { fixture: "CREATE TABLE t(k TEXT, v INT); INSERT INTO t VALUES ('a',1);", expectedRows: [{ k: "a", s: 1 }] },
        // Unterminated INSERT - a bank bug, reached only after case 1 has already passed.
        { fixture: "CREATE TABLE t(k TEXT, v INT); INSERT INTO t VALUES ('z',7", expectedRows: [{ k: "z", s: 7 }] },
      ],
    };
    const { lines, restore } = captureLog();
    let outcome: DrillOutcome;
    try {
      outcome = await runDrill(brokenFixture, solutionFile(sqlEx.starterCode));
    } finally {
      restore();
    }
    // Abandoned is what stops cli/index.ts recording the session: a broken exercise must
    // not move the unaided rating, exactly as a missing JDK must not.
    expect(outcome.abandoned).toBe(true);
    expect(outcome.passed).toBe(0);
    expect(outcome.score).toBe(0);
    expect(lines.join("\n")).toContain("Your code did not run");
  }, 30_000);
});

if (!hasJdk()) console.warn("⚠ JDK not found - harness drill session tests SKIPPED. Install JDK 21 to validate them.");
describe.skipIf(!hasJdk())("runDrill - harness kinds", () => {
  it("routes write-harness through the code drill and grades the solution file", async () => {
    const answer = solutionFile(
      "public class Solution {\n    private int n = 0;\n    public synchronized void increment() { n++; }\n    public synchronized int value() { return n; }\n}\n",
    );
    const outcome = await runDrill(harnessEx, answer);
    expect(outcome.abandoned).toBe(false);
    expect(outcome.passed).toBe(1);
    expect(outcome.total).toBe(1);
    expect(outcome.score).toBeGreaterThan(0);
  }, 90_000);

  it("renders a failed check by name, never as `test #N`", async () => {
    const failing: HarnessExercise = {
      ...harnessEx,
      id: "conc-java-951",
      submitPolicy: "single",
      starterCode: "public class Solution {\n    public void increment() {}\n    public int value() { return 0; }\n}\n",
    };
    const { outcome, output } = await driveDrill(failing, ["", ""]);
    expect(outcome.passed).toBe(0);
    expect(output).toContain("✗ increment() advances value()");
    expect(output).not.toContain("test #");
  }, 90_000);
});

const recallEx: RecallExercise = {
  id: "rec-any-950",
  kind: "recall",
  axis: "decomposition",
  language: "any",
  tier: 1,
  title: "two heads",
  prompt: "Probability of two heads in two fair flips?",
  softTimeLimitSeconds: 120,
  testTimeoutMs: 10_000,
  acceptedAnswers: ["1/4"],
  reveal: "Two independent halves multiply.",
};

describe("runDrill - recall", () => {
  it("scores an equivalent numeric answer via --solution and prints the reveal", async () => {
    const { lines, restore } = captureLog();
    let outcome: DrillOutcome;
    try {
      outcome = await runDrill(recallEx, solutionFile("25%\ntrailing junk is ignored\n"));
    } finally {
      restore();
    }
    expect(outcome.abandoned).toBe(false);
    expect(outcome.passed).toBe(1);
    expect(outcome.total).toBe(1);
    expect(outcome.score).toBe(1);
    const output = lines.join("\n");
    expect(output).toContain("✓ correct");
    expect(output).toContain("Two independent halves multiply.");
  });

  it("scores a wrong answer 0 and shows what was accepted", async () => {
    const { lines, restore } = captureLog();
    let outcome: DrillOutcome;
    try {
      outcome = await runDrill(recallEx, solutionFile("1/3\n"));
    } finally {
      restore();
    }
    expect(outcome.abandoned).toBe(false);
    expect(outcome.passed).toBe(0);
    expect(outcome.score).toBe(0);
    expect(lines.join("\n")).toContain("Accepted: 1/4");
  });

  it("grades interactively and reveals the derivation", async () => {
    const { outcome, output } = await driveDrill(recallEx, ["0.25"], "Your answer");
    expect(outcome.passed).toBe(1);
    expect(output).toContain("✓ correct");
    expect(output).toContain("Two independent halves multiply.");
  }, 30_000);

  it("abandons on q without scoring or revealing the answer", async () => {
    const { outcome, output } = await driveDrill(recallEx, ["q"], "Your answer");
    expect(outcome.abandoned).toBe(true);
    expect(outcome.passed).toBe(0);
    expect(outcome.score).toBe(0);
    // Quitting must not hand over the answer - the reveal is the reward for answering.
    expect(output).not.toContain("Accepted: 1/4");
    expect(output).not.toContain("Two independent halves multiply.");
  }, 30_000);

  it("survives an exercise with no reveal", async () => {
    const { reveal: _reveal, ...noReveal } = recallEx;
    const { lines, restore } = captureLog();
    let outcome: DrillOutcome;
    try {
      outcome = await runDrill(noReveal, solutionFile("0.25\n"));
    } finally {
      restore();
    }
    expect(outcome.passed).toBe(1);
    expect(lines.join("\n")).toContain("✓ correct");
  });

  it("keeps the indent of a reveal that opens with a table row", async () => {
    // Reveals are how the recall drills teach the rest of their table, and a table
    // usually starts on line one. Trimming the whole string would strip that first row's
    // indent alone, printing it shifted left under rows that kept theirs.
    const tableReveal = {
      ...recallEx,
      reveal: "  OU   old-gen used\n  OC   old-gen capacity\n",
    };
    const { lines, restore } = captureLog();
    try {
      await runDrill(tableReveal, solutionFile("0.25\n"));
    } finally {
      restore();
    }
    const output = lines.join("\n");
    expect(output).toContain("  OU   old-gen used");
    expect(output).toContain("  OC   old-gen capacity");
  });
});

const clozeEx: ClozeExercise = {
  id: "api-py-950",
  kind: "cloze",
  axis: "api-memory",
  language: "python",
  tier: 1,
  title: "sort by length",
  prompt: "Fill the blank so the words sort shortest-to-longest.",
  softTimeLimitSeconds: 60,
  testTimeoutMs: 10_000,
  snippet: "sorted(words, key=____)",
  acceptedAnswers: ["len"],
};

/** Two blanks, two answers: the shape that earns partial credit. */
const perBlankEx: ClozeExercise = {
  ...clozeEx,
  id: "api-java-950",
  language: "java",
  snippet: "list.____(x);\nlist.____(0);",
  acceptedAnswers: [["add"], ["remove"]],
};

/** Two blanks, one answer for both - what api-py-003/004 ship today. */
const sharedBlankEx: ClozeExercise = {
  ...clozeEx,
  id: "api-py-951",
  snippet: 'import ____\n\nconfig = ____.load(f)',
  acceptedAnswers: ["json"],
};

describe("runDrill - cloze", () => {
  it("grades a single blank from a solution file, as it always has", async () => {
    const { lines, restore } = captureLog();
    let outcome: DrillOutcome;
    try {
      outcome = await runDrill(clozeEx, solutionFile("  len \n"));
    } finally {
      restore();
    }
    expect(outcome.passed).toBe(1);
    expect(outcome.total).toBe(1);
    expect(lines.join("\n")).toContain("✓ correct");
  });

  it("asks once per blank and gives partial credit", async () => {
    const { outcome, output, prompts } = await driveDrill(perBlankEx, ["add", "nope"], "Blank ");
    expect(outcome.passed).toBe(1);
    expect(outcome.total).toBe(2);
    expect(outcome.score).toBeGreaterThan(0);
    expect(prompts).toContain("Blank 1/2");
    expect(prompts).toContain("Blank 2/2");
    expect(output).toContain("1/2 blanks correct");
    // Only the blank they missed is spelled out - the one they got stays unspoiled.
    expect(output).toContain("blank 2 accepted: remove");
    expect(output).not.toContain("blank 1 accepted");
  }, 30_000);

  it("reads one answer per line in --solution mode", async () => {
    const { lines, restore } = captureLog();
    let outcome: DrillOutcome;
    try {
      outcome = await runDrill(perBlankEx, solutionFile("add\nremove\n"));
    } finally {
      restore();
    }
    expect(outcome.passed).toBe(2);
    expect(outcome.total).toBe(2);
    expect(lines.join("\n")).toContain("✓ correct");
  });

  it("asks once when one answer fills every blank, and credits them all", async () => {
    const { outcome, output } = await driveDrill(sharedBlankEx, ["json"], "Fill the blank");
    expect(outcome.passed).toBe(2);
    expect(outcome.total).toBe(2);
    expect(output).toContain("One answer fills all 2 blanks");
    expect(output).toContain("✓ correct");
  }, 30_000);

  it("abandons on q mid-way through the blanks, scoring nothing", async () => {
    const { outcome, output } = await driveDrill(perBlankEx, ["add", "q"], "Blank ");
    expect(outcome.abandoned).toBe(true);
    expect(outcome.passed).toBe(0);
    expect(outcome.score).toBe(0);
    expect(output).not.toContain("accepted: remove");
  }, 30_000);
});

describe("previewExercise - cloze", () => {
  it("counts the blanks without leaking an answer", () => {
    const { lines, restore } = captureLog();
    try {
      previewExercise(sharedBlankEx);
    } finally {
      restore();
    }
    const output = lines.join("\n");
    expect(output).toContain("(you would fill the 2 ____ blanks)");
    expect(output).not.toContain("json\n");
  });
});

describe("previewExercise - recall", () => {
  it("explains that numeric forms are equivalent, and never leaks the answer", () => {
    const { lines, restore } = captureLog();
    try {
      previewExercise(recallEx);
    } finally {
      restore();
    }
    const output = lines.join("\n");
    expect(output).toContain("Probability of two heads");
    expect(output).toMatch(/1\/4, 0\.25, 25%/);
    expect(output).not.toContain("Two independent halves multiply.");
  });
});

describe("runDrill - predict-output via --solution when the snippet never ran", () => {
  const brokenSnippet: PredictExercise = {
    id: "cr-py-950",
    kind: "predict-output",
    axis: "code-reading",
    language: "python",
    tier: 1,
    title: "broken snippet",
    prompt: "What does this print?",
    // Exits non-zero: gradePrediction reports that as `error` (a bank bug or a broken
    // toolchain), with credit 0.
    snippet: "import sys\nprint('half')\nsys.exit(3)\n",
    softTimeLimitSeconds: 120,
    testTimeoutMs: 15_000,
  };

  it("abandons instead of recording the 0 that gradePrediction returns alongside an error", async () => {
    // The interactive branch already abandons on `error`. The scripted branch must too:
    // returning r.credit (always 0 on error) lets drillOnce record a 0 and move the
    // unaided rating on evidence that was never about the user - the same invariant the
    // code kinds' --solution branch keeps (and that "harnessError is never evidence" names).
    const { lines, restore } = captureLog();
    let outcome: DrillOutcome;
    try {
      outcome = await runDrill(brokenSnippet, solutionFile("half\n"));
    } finally {
      restore();
    }
    expect(outcome.abandoned).toBe(true);
    expect(outcome.score).toBe(0);
    expect(lines.join("\n")).toContain("snippet failed to run");
  }, 30_000);

  it("still scores a scripted prediction when the snippet ran", async () => {
    const fine: PredictExercise = { ...brokenSnippet, id: "cr-py-951", snippet: "print('half')\n" };
    const { restore } = captureLog();
    let outcome: DrillOutcome;
    try {
      outcome = await runDrill(fine, solutionFile("half\n"));
    } finally {
      restore();
    }
    expect(outcome.abandoned).toBe(false);
    expect(outcome.score).toBeGreaterThan(0);
  }, 30_000);
});
