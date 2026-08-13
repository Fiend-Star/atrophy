import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodeExercise, Exercise, HarnessExercise, RecallExercise } from "../bank/schema.js";
import { hasJdk } from "./javatool.js";
import { previewExercise, runDrill, type DrillOutcome } from "./session.js";

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
      // Reaching a retry prompt at all is the proof the submission was not consumed.
      expect(prompts).toContain("fix & resubmit");
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
